"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const request = require("supertest");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config");

function configFor(dataDir, overrides = {}) {
  return loadConfig({
    APP_NAME: "TestShelf",
    PORT: "3000",
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: "http://localhost:3000",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "correct horse battery staple",
    SESSION_SECRET: "test-session-secret-with-enough-randomness",
    MAX_UPLOAD_MB: "5",
    ALLOW_PUBLIC_DOWNLOAD: "true",
    ...overrides,
  });
}

async function samplePdf(title = "Test Magazine", pages = 3) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = pdf.addPage([600, 800]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 600,
      height: 800,
      color: rgb(0.96, 0.94, 0.9),
    });
    page.drawText(`${title} — Page ${pageNumber}`, {
      x: 55,
      y: 700,
      size: 28,
      font,
      color: rgb(0.35, 0.12, 0.08),
    });
  }
  return Buffer.from(await pdf.save());
}

async function login(agent) {
  const response = await agent
    .post("/admin/login")
    .type("form")
    .send({
      username: "admin",
      password: "correct horse battery staple",
    });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/admin");
}

describe("configuration", () => {
  test("fails clearly when required environment variables are absent", () => {
    assert.throws(
      () => loadConfig({}),
      /Missing required environment variable: PUBLIC_BASE_URL/,
    );
  });

  test("validates booleans and positive numbers", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magshelf-config-"));
    assert.throws(
      () => configFor(directory, { ALLOW_PUBLIC_DOWNLOAD: "sometimes" }),
      /must be either "true" or "false"/,
    );
    assert.throws(
      () => configFor(directory, { MAX_UPLOAD_MB: "0" }),
      /must be a positive integer/,
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("MagShelf HTTP application", { concurrency: false }, () => {
  test("supports the authenticated magazine lifecycle and persistent storage", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "magshelf-app-"));
    let app = createApp(configFor(dataDir));
    const anonymous = request(app);
    const admin = request.agent(app);
    const pdf = await samplePdf();

    try {
      const emptyHome = await anonymous.get("/");
      assert.equal(emptyHome.status, 200);
      assert.match(emptyHome.text, /The shelf is waiting/);

      const protectedPage = await anonymous.get("/admin");
      assert.equal(protectedPage.status, 302);
      assert.equal(protectedPage.headers.location, "/admin/login");

      const failedLogin = await admin
        .post("/admin/login")
        .type("form")
        .send({ username: "admin", password: "wrong" });
      assert.equal(failedLogin.status, 401);
      assert.match(failedLogin.text, /username or password was incorrect/i);

      await login(admin);
      const dashboard = await admin.get("/admin");
      assert.equal(dashboard.status, 200);
      assert.match(dashboard.text, /Add a magazine/);

      const invalidUpload = await admin
        .post("/admin/magazines")
        .field("title", "Not really a PDF")
        .field("is_published", "on")
        .attach("pdf", Buffer.from("not a pdf"), {
          filename: "fake.pdf",
          contentType: "application/pdf",
        });
      assert.equal(invalidUpload.status, 400);
      assert.match(invalidUpload.text, /not a valid PDF/i);

      const created = await admin
        .post("/admin/magazines")
        .field("title", "School Magazine")
        .field("issue_label", "Term 2")
        .field("issue_date", "2026-07-02")
        .field("description", "Stories from around our school.")
        .field("is_published", "on")
        .attach("pdf", pdf, {
          filename: "school magazine.pdf",
          contentType: "application/pdf",
        });
      assert.equal(created.status, 302);
      assert.equal(created.headers.location, "/admin");

      const row = app.locals.resources.db
        .prepare("SELECT * FROM magazines WHERE title = ?")
        .get("School Magazine");
      assert.ok(row);
      assert.equal(row.slug, "school-magazine-term-2");
      assert.equal(row.is_published, 1);
      assert.ok(
        fs.existsSync(path.join(dataDir, "uploads", "pdfs", row.pdf_filename)),
      );

      const home = await anonymous.get("/");
      assert.equal(home.status, 200);
      assert.match(home.text, /School Magazine/);
      assert.match(home.text, /Read issue/);

      const viewer = await anonymous.get(`/m/${row.slug}`);
      assert.equal(viewer.status, 200);
      assert.match(viewer.text, /id="magazine-viewer"/);
      assert.match(viewer.text, /id="layout-choice"/);
      assert.match(viewer.text, /id="layout-switch"/);
      assert.match(viewer.text, /magazine-viewer\.js/);

      const publicPdf = await anonymous.get(`/media/pdfs/${row.pdf_filename}`);
      assert.equal(publicPdf.status, 200);
      assert.match(publicPdf.headers["content-type"], /application\/pdf/);
      assert.match(publicPdf.headers["accept-ranges"], /bytes/);

      const traversal = await anonymous.get(
        "/media/pdfs/%2E%2E%2Fprivate.txt",
      );
      assert.equal(traversal.status, 404);

      const second = await admin
        .post("/admin/magazines")
        .field("title", "School Magazine")
        .field("issue_label", "Term 2")
        .field("is_published", "on")
        .attach("pdf", pdf, {
          filename: "second.pdf",
          contentType: "application/pdf",
        });
      assert.equal(second.status, 302);
      const secondRow = app.locals.resources.db
        .prepare("SELECT * FROM magazines WHERE id <> ?")
        .get(row.id);
      assert.equal(secondRow.slug, "school-magazine-term-2-2");

      const duplicateExplicitSlug = await admin
        .post("/admin/magazines")
        .field("title", "Duplicate")
        .field("slug", row.slug)
        .field("is_published", "on")
        .attach("pdf", pdf, {
          filename: "duplicate.pdf",
          contentType: "application/pdf",
        });
      assert.equal(duplicateExplicitSlug.status, 400);
      assert.match(duplicateExplicitSlug.text, /slug is already in use/i);

      const toggled = await admin.post(
        `/admin/magazines/${row.id}/toggle-published`,
      );
      assert.equal(toggled.status, 302);
      assert.equal((await anonymous.get(`/m/${row.slug}`)).status, 404);
      assert.equal(
        (await anonymous.get(`/media/pdfs/${row.pdf_filename}`)).status,
        404,
      );
      assert.equal(
        (await admin.get(`/media/pdfs/${row.pdf_filename}`)).status,
        200,
      );

      const edited = await admin
        .post(`/admin/magazines/${row.id}/edit`)
        .field("title", "School Magazine Updated")
        .field("slug", "school-magazine-updated")
        .field("issue_label", "Term 3")
        .field("issue_date", "2026-09-15")
        .field("description", "Updated description")
        .field("is_published", "on");
      assert.equal(edited.status, 302);
      const updatedRow = app.locals.resources.db
        .prepare("SELECT * FROM magazines WHERE id = ?")
        .get(row.id);
      assert.equal(updatedRow.title, "School Magazine Updated");
      assert.equal(updatedRow.is_published, 1);

      app.locals.resources.close();
      app = createApp(configFor(dataDir));
      const persistentRow = app.locals.resources.db
        .prepare("SELECT * FROM magazines WHERE id = ?")
        .get(row.id);
      assert.equal(persistentRow.title, "School Magazine Updated");
      assert.ok(
        fs.existsSync(
          path.join(dataDir, "uploads", "pdfs", persistentRow.pdf_filename),
        ),
      );

      const restartedAdmin = request.agent(app);
      await login(restartedAdmin);
      const deleted = await restartedAdmin.post(
        `/admin/magazines/${persistentRow.id}/delete`,
      );
      assert.equal(deleted.status, 302);
      assert.equal(
        app.locals.resources.db
          .prepare("SELECT COUNT(*) AS count FROM magazines WHERE id = ?")
          .get(persistentRow.id).count,
        0,
      );
      assert.equal(
        fs.existsSync(
          path.join(dataDir, "uploads", "pdfs", persistentRow.pdf_filename),
        ),
        false,
      );
    } finally {
      try {
        app.locals.resources.close();
      } catch {
        // The test may have closed the first app before reopening it.
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("hides download controls when public downloads are disabled", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "magshelf-nodl-"));
    const app = createApp(
      configFor(dataDir, { ALLOW_PUBLIC_DOWNLOAD: "false" }),
    );
    const admin = request.agent(app);
    try {
      await login(admin);
      await admin
        .post("/admin/magazines")
        .field("title", "Read Only")
        .field("is_published", "on")
        .attach("pdf", await samplePdf("Read Only", 1), {
          filename: "read-only.pdf",
          contentType: "application/pdf",
        });
      const row = app.locals.resources.db
        .prepare("SELECT * FROM magazines WHERE title = ?")
        .get("Read Only");
      const viewer = await request(app).get(`/m/${row.slug}`);
      assert.equal(viewer.status, 200);
      assert.doesNotMatch(viewer.text, />Download</);
      assert.equal(
        (await request(app).get(`/media/pdfs/${row.pdf_filename}`)).status,
        200,
      );
    } finally {
      app.locals.resources.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
