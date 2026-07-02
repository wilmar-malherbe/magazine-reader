"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const helmet = require("helmet");
const slugify = require("slugify");
const { credentialsMatch, isAdmin, requireAdmin } = require("./auth");
const { openDatabase } = require("./db");
const {
  cleanupUploads,
  moveUpload,
  removeIfPresent,
  safeMediaPath,
  safeStem,
  validateUpload,
} = require("./files");
const { createUploadMiddleware } = require("./upload");
const { BetterSqliteSessionStore } = require("./session-store");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function text(value, maxLength = 10_000) {
  return String(value || "").trim().slice(0, maxLength);
}

function isChecked(value) {
  return value === "on" || value === "1" || value === "true";
}

function validateMagazineFields(body, { pdfRequired }) {
  const title = text(body.title, 200);
  const requestedSlug = text(body.slug, 160);
  const description = text(body.description, 10_000);
  const issueLabel = text(body.issue_label, 160);
  const issueDate = text(body.issue_date, 10);

  if (!title) throw Object.assign(new Error("Title is required."), { status: 400 });
  if (pdfRequired && !body.hasPdf) {
    throw Object.assign(new Error("A PDF magazine is required."), { status: 400 });
  }
  if (issueDate && !DATE_PATTERN.test(issueDate)) {
    throw Object.assign(new Error("Issue date must use YYYY-MM-DD."), {
      status: 400,
    });
  }
  if (issueDate) {
    const parsedIssueDate = new Date(`${issueDate}T00:00:00Z`);
    if (
      Number.isNaN(parsedIssueDate.getTime()) ||
      parsedIssueDate.toISOString().slice(0, 10) !== issueDate
    ) {
      throw Object.assign(
        new Error("Issue date is not a valid calendar date."),
        { status: 400 },
      );
    }
  }

  const cleanedSlug = requestedSlug
    ? slugify(requestedSlug, { lower: true, strict: true, trim: true })
    : "";
  if (requestedSlug && !cleanedSlug) {
    throw Object.assign(new Error("Slug must contain letters or numbers."), {
      status: 400,
    });
  }

  return {
    title,
    requestedSlug: cleanedSlug,
    description: description || null,
    issueLabel: issueLabel || null,
    issueDate: issueDate || null,
    isPublished: isChecked(body.is_published) ? 1 : 0,
  };
}

function nextAvailableSlug(db, base, excludedId = null) {
  const stem = safeStem(base);
  let candidate = stem;
  let suffix = 2;
  const query = excludedId
    ? db.prepare("SELECT id FROM magazines WHERE slug = ? AND id <> ?")
    : db.prepare("SELECT id FROM magazines WHERE slug = ?");

  while (
    excludedId ? query.get(candidate, excludedId) : query.get(candidate)
  ) {
    candidate = `${stem}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function createApp(config) {
  const app = express();
  const { db, paths } = openDatabase(config.dataDir);
  const sessionStore = new BetterSqliteSessionStore(db);
  const upload = createUploadMiddleware(config, paths);

  app.locals.resources = {
    db,
    sessionStore,
    close() {
      db.close();
    },
  };

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          workerSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(
    session({
      name: "magshelf.sid",
      secret: config.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: "auto",
        maxAge: 12 * 60 * 60 * 1000,
      },
    }),
  );

  app.use((req, res, next) => {
    res.locals.appName = config.appName;
    res.locals.allowPublicDownload = config.allowPublicDownload;
    res.locals.isAdmin = isAdmin(req);
    res.locals.currentPath = req.path;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.formatDate = (value) => {
      if (!value) return "";
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat("en", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          }).format(date);
    };
    next();
  });

  app.use(
    "/css",
    express.static(path.join(__dirname, "..", "public", "css"), {
      immutable: true,
      maxAge: "1h",
    }),
  );
  app.use(
    "/js",
    express.static(path.join(__dirname, "..", "public", "js"), {
      immutable: true,
      maxAge: "1h",
    }),
  );

  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const pageFlipRoot = path.dirname(require.resolve("page-flip/package.json"));
  app.use(
    "/vendor/pdfjs/build",
    express.static(path.join(pdfjsRoot, "build"), {
      immutable: true,
      maxAge: "30d",
    }),
  );
  app.use(
    "/vendor/pdfjs/cmaps",
    express.static(path.join(pdfjsRoot, "cmaps"), {
      immutable: true,
      maxAge: "30d",
    }),
  );
  app.use(
    "/vendor/page-flip",
    express.static(path.join(pageFlipRoot, "dist", "js"), {
      immutable: true,
      maxAge: "30d",
    }),
  );

  app.get("/healthz", (req, res) => res.sendStatus(204));

  app.get("/", (req, res) => {
    const magazines = db
      .prepare(
        `SELECT * FROM magazines
         WHERE is_published = 1
         ORDER BY
           CASE WHEN issue_date IS NULL OR issue_date = '' THEN 1 ELSE 0 END,
           issue_date DESC,
           created_at DESC`,
      )
      .all();
    res.render("index", { title: config.appName, magazines });
  });

  app.get("/m/:slug", (req, res) => {
    const magazine = db
      .prepare("SELECT * FROM magazines WHERE slug = ?")
      .get(req.params.slug);
    if (!magazine || (!magazine.is_published && !isAdmin(req))) {
      return res.status(404).render("error", {
        title: "Magazine not found",
        status: 404,
        message: "That magazine is not available.",
      });
    }
    return res.render("magazine", {
      title: magazine.title,
      magazine,
    });
  });

  app.get("/media/pdfs/:filename", (req, res, next) => {
    const magazine = db
      .prepare(
        `SELECT id, title, original_pdf_filename, is_published
         FROM magazines WHERE pdf_filename = ?`,
      )
      .get(req.params.filename);
    if (!magazine || (!magazine.is_published && !isAdmin(req))) {
      return res.sendStatus(404);
    }

    const filePath = safeMediaPath(paths.pdfs, req.params.filename);
    if (!filePath) return res.sendStatus(404);

    if (req.query.download === "1" && config.allowPublicDownload) {
      return res.download(filePath, magazine.original_pdf_filename, (error) => {
        if (error && !res.headersSent) next(error);
      });
    }
    res.type("application/pdf");
    res.set("Content-Disposition", "inline");
    return res.sendFile(filePath, (error) => {
      if (error && !res.headersSent) next(error);
    });
  });

  app.get("/media/covers/:filename", (req, res, next) => {
    const magazine = db
      .prepare(
        "SELECT id, is_published FROM magazines WHERE cover_filename = ?",
      )
      .get(req.params.filename);
    if (!magazine || (!magazine.is_published && !isAdmin(req))) {
      return res.sendStatus(404);
    }
    const filePath = safeMediaPath(paths.covers, req.params.filename);
    if (!filePath) return res.sendStatus(404);
    res.set("Cache-Control", "public, max-age=3600");
    return res.sendFile(filePath, (error) => {
      if (error && !res.headersSent) next(error);
    });
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });

  app.get("/admin/login", (req, res) => {
    if (isAdmin(req)) return res.redirect("/admin");
    return res.render("admin-login", {
      title: "Admin login",
      error: null,
    });
  });

  app.post("/admin/login", loginLimiter, (req, res, next) => {
    const username = text(req.body.username, 500);
    const password = String(req.body.password || "");
    if (!credentialsMatch(config, username, password)) {
      return res.status(401).render("admin-login", {
        title: "Admin login",
        error: "The username or password was incorrect.",
      });
    }

    const returnTo =
      req.session.returnTo?.startsWith("/") &&
      !req.session.returnTo.startsWith("//")
        ? req.session.returnTo
        : "/admin";
    return req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.isAdmin = true;
      return req.session.save((saveError) => {
        if (saveError) return next(saveError);
        return res.redirect(returnTo);
      });
    });
  });

  app.post("/admin/logout", requireAdmin, (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("magshelf.sid");
      return res.redirect("/");
    });
  });

  app.get("/admin", requireAdmin, (req, res) => {
    const magazines = db
      .prepare("SELECT * FROM magazines ORDER BY created_at DESC")
      .all();
    res.render("admin-dashboard", {
      title: "Admin dashboard",
      magazines,
      maxUploadMb: config.maxUploadMb,
    });
  });

  app.post(
    "/admin/magazines",
    requireAdmin,
    (req, res, next) => {
      upload(req, res, async (error) => {
        if (error) {
          await cleanupUploads(req.files);
          error.status = 400;
          return next(error);
        }
        return next();
      });
    },
    async (req, res) => {
      const pdf = req.files?.pdf?.[0];
      const cover = req.files?.cover?.[0];
      const moved = [];

      try {
        const fields = validateMagazineFields(
          { ...req.body, hasPdf: Boolean(pdf) },
          { pdfRequired: true },
        );
        await validateUpload(pdf, "pdf");
        await validateUpload(cover, "cover");

        let slug;
        if (fields.requestedSlug) {
          if (
            db
              .prepare("SELECT id FROM magazines WHERE slug = ?")
              .get(fields.requestedSlug)
          ) {
            throw Object.assign(new Error("That slug is already in use."), {
              status: 400,
            });
          }
          slug = fields.requestedSlug;
        } else {
          slug = nextAvailableSlug(
            db,
            [fields.title, fields.issueLabel || fields.issueDate]
              .filter(Boolean)
              .join("-"),
          );
        }

        const savedPdf = await moveUpload(pdf, paths.pdfs, fields.title);
        moved.push(savedPdf.destination);
        const savedCover = cover
          ? await moveUpload(cover, paths.covers, `${fields.title}-cover`)
          : null;
        if (savedCover) moved.push(savedCover.destination);

        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO magazines (
             slug, title, description, issue_label, issue_date,
             pdf_filename, original_pdf_filename, cover_filename,
             page_count, is_published, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).run(
          slug,
          fields.title,
          fields.description,
          fields.issueLabel,
          fields.issueDate,
          savedPdf.filename,
          path.basename(pdf.originalname),
          savedCover?.filename || null,
          fields.isPublished,
          now,
          now,
        );

        setFlash(req, "success", `${fields.title} was added.`);
        return res.redirect("/admin");
      } catch (error) {
        await Promise.allSettled(moved.map(removeIfPresent));
        await cleanupUploads(req.files);
        throw error;
      }
    },
  );

  app.get("/admin/magazines/:id/edit", requireAdmin, (req, res) => {
    const magazine = db
      .prepare("SELECT * FROM magazines WHERE id = ?")
      .get(req.params.id);
    if (!magazine) {
      return res.status(404).render("error", {
        title: "Magazine not found",
        status: 404,
        message: "That magazine does not exist.",
      });
    }
    return res.render("admin-edit", {
      title: `Edit ${magazine.title}`,
      magazine,
      maxUploadMb: config.maxUploadMb,
    });
  });

  app.post(
    "/admin/magazines/:id/edit",
    requireAdmin,
    (req, res, next) => {
      upload(req, res, async (error) => {
        if (error) {
          await cleanupUploads(req.files);
          error.status = 400;
          return next(error);
        }
        return next();
      });
    },
    async (req, res) => {
      const magazine = db
        .prepare("SELECT * FROM magazines WHERE id = ?")
        .get(req.params.id);
      if (!magazine) {
        await cleanupUploads(req.files);
        return res.status(404).render("error", {
          title: "Magazine not found",
          status: 404,
          message: "That magazine does not exist.",
        });
      }

      const pdf = req.files?.pdf?.[0];
      const cover = req.files?.cover?.[0];
      const moved = [];
      let committed = false;
      try {
        const fields = validateMagazineFields(
          { ...req.body, hasPdf: true },
          { pdfRequired: false },
        );
        await validateUpload(pdf, "pdf");
        await validateUpload(cover, "cover");

        const requestedSlug =
          fields.requestedSlug ||
          nextAvailableSlug(
            db,
            [fields.title, fields.issueLabel || fields.issueDate]
              .filter(Boolean)
              .join("-"),
            magazine.id,
          );
        const conflict = db
          .prepare("SELECT id FROM magazines WHERE slug = ? AND id <> ?")
          .get(requestedSlug, magazine.id);
        if (conflict) {
          throw Object.assign(new Error("That slug is already in use."), {
            status: 400,
          });
        }

        const savedPdf = pdf
          ? await moveUpload(pdf, paths.pdfs, fields.title)
          : null;
        if (savedPdf) moved.push(savedPdf.destination);
        const savedCover = cover
          ? await moveUpload(cover, paths.covers, `${fields.title}-cover`)
          : null;
        if (savedCover) moved.push(savedCover.destination);

        db.prepare(
          `UPDATE magazines SET
             slug = ?, title = ?, description = ?, issue_label = ?,
             issue_date = ?, pdf_filename = ?, original_pdf_filename = ?,
             cover_filename = ?, is_published = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          requestedSlug,
          fields.title,
          fields.description,
          fields.issueLabel,
          fields.issueDate,
          savedPdf?.filename || magazine.pdf_filename,
          pdf ? path.basename(pdf.originalname) : magazine.original_pdf_filename,
          savedCover?.filename || magazine.cover_filename,
          fields.isPublished,
          new Date().toISOString(),
          magazine.id,
        );
        committed = true;

        await Promise.allSettled([
          savedPdf
            ? removeIfPresent(path.join(paths.pdfs, magazine.pdf_filename))
            : Promise.resolve(),
          savedCover && magazine.cover_filename
            ? removeIfPresent(
                path.join(paths.covers, magazine.cover_filename),
              )
            : Promise.resolve(),
        ]);
        setFlash(req, "success", `${fields.title} was updated.`);
        return res.redirect("/admin");
      } catch (error) {
        if (!committed) {
          await Promise.allSettled(moved.map(removeIfPresent));
        }
        await cleanupUploads(req.files);
        throw error;
      }
    },
  );

  app.post(
    "/admin/magazines/:id/toggle-published",
    requireAdmin,
    (req, res) => {
      const magazine = db
        .prepare("SELECT id, title, is_published FROM magazines WHERE id = ?")
        .get(req.params.id);
      if (!magazine) return res.sendStatus(404);
      const published = magazine.is_published ? 0 : 1;
      db.prepare(
        "UPDATE magazines SET is_published = ?, updated_at = ? WHERE id = ?",
      ).run(published, new Date().toISOString(), magazine.id);
      setFlash(
        req,
        "success",
        `${magazine.title} is now ${published ? "published" : "unpublished"}.`,
      );
      return res.redirect("/admin");
    },
  );

  app.post(
    "/admin/magazines/:id/delete",
    requireAdmin,
    async (req, res) => {
      const magazine = db
        .prepare("SELECT * FROM magazines WHERE id = ?")
        .get(req.params.id);
      if (!magazine) return res.sendStatus(404);

      const candidates = [
        {
          source: path.join(paths.pdfs, magazine.pdf_filename),
          staged: path.join(
            paths.temp,
            `delete-${crypto.randomBytes(8).toString("hex")}.pdf`,
          ),
        },
      ];
      if (magazine.cover_filename) {
        candidates.push({
          source: path.join(paths.covers, magazine.cover_filename),
          staged: path.join(
            paths.temp,
            `delete-${crypto.randomBytes(8).toString("hex")}${path.extname(
              magazine.cover_filename,
            )}`,
          ),
        });
      }

      const staged = [];
      try {
        for (const candidate of candidates) {
          try {
            await fs.promises.rename(candidate.source, candidate.staged);
            staged.push(candidate);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        db.prepare("DELETE FROM magazines WHERE id = ?").run(magazine.id);
      } catch (error) {
        await Promise.allSettled(
          staged.map((file) => fs.promises.rename(file.staged, file.source)),
        );
        throw error;
      }

      await Promise.allSettled(staged.map((file) => removeIfPresent(file.staged)));
      setFlash(req, "success", `${magazine.title} was deleted.`);
      return res.redirect("/admin");
    },
  );

  app.use((req, res) => {
    res.status(404).render("error", {
      title: "Page not found",
      status: 404,
      message: "The page you requested could not be found.",
    });
  });

  app.use(async (error, req, res, next) => {
    if (res.headersSent) return next(error);
    await cleanupUploads(req.files);
    const status =
      Number.isInteger(error.status) && error.status >= 400
        ? error.status
        : error.code === "LIMIT_FILE_SIZE"
          ? 413
          : 500;
    const safeMessage =
      status < 500
        ? error.message
        : "Something went wrong while processing your request.";
    if (status >= 500) console.error(error);
    return res.status(status).render("error", {
      title: status === 413 ? "Upload too large" : "Request failed",
      status,
      message: safeMessage,
    });
  });

  return app;
}

module.exports = {
  createApp,
  nextAvailableSlug,
  validateMagazineFields,
};
