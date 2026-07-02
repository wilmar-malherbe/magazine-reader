"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const slugify = require("slugify");

const PDF_EXTENSIONS = new Set([".pdf"]);
const COVER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizedExtension(filename) {
  return path.extname(filename || "").toLowerCase();
}

function uploadFilter(req, file, callback) {
  const extension = normalizedExtension(file.originalname);
  const extensionAllowed =
    file.fieldname === "pdf"
      ? PDF_EXTENSIONS.has(extension)
      : file.fieldname === "cover" && COVER_EXTENSIONS.has(extension);
  const mimeAllowed =
    file.fieldname === "pdf"
      ? new Set(["application/pdf", "application/x-pdf"]).has(file.mimetype)
      : file.fieldname === "cover" &&
        new Set(["image/jpeg", "image/png", "image/webp"]).has(file.mimetype);
  const allowed = extensionAllowed && mimeAllowed;

  if (!allowed) {
    return callback(
      new Error(
        file.fieldname === "pdf"
          ? "The magazine must be a PDF file."
          : "The cover must be a JPG, PNG, or WebP image.",
      ),
    );
  }
  return callback(null, true);
}

async function readHeader(filePath, length = 16) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function detectedType(header) {
  if (header.subarray(0, 5).toString("ascii") === "%PDF-") return ".pdf";
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return ".png";
  }
  if (
    header.length >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff
  ) {
    return ".jpg";
  }
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  return null;
}

async function validateUpload(file, expectedKind) {
  if (!file) return;
  const extension = normalizedExtension(file.originalname);
  const type = detectedType(await readHeader(file.path));

  if (expectedKind === "pdf" && type !== ".pdf") {
    throw validationError("The uploaded magazine is not a valid PDF file.");
  }
  if (expectedKind === "cover") {
    const validType = new Set([".jpg", ".png", ".webp"]);
    if (!validType.has(type)) {
      throw validationError(
        "The uploaded cover is not a valid JPG, PNG, or WebP image.",
      );
    }
    if ((extension === ".jpg" || extension === ".jpeg") && type === ".jpg") return;
    if (extension !== type) {
      throw validationError(
        "The cover extension does not match its file contents.",
      );
    }
  }
}

function safeStem(value, fallback = "magazine") {
  return (
    slugify(String(value || ""), { lower: true, strict: true, trim: true }).slice(
      0,
      80,
    ) || fallback
  );
}

function generatedFilename(originalName, title) {
  const extension = normalizedExtension(originalName);
  const date = new Date().toISOString().slice(0, 10);
  const random = crypto.randomBytes(6).toString("hex");
  return `${date}_${random}_${safeStem(title)}${extension}`;
}

async function moveUpload(file, destinationDirectory, title) {
  if (!file) return null;
  const filename = generatedFilename(file.originalname, title);
  const destination = path.join(destinationDirectory, filename);
  await fs.promises.rename(file.path, destination);
  return { filename, destination };
}

async function removeIfPresent(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function cleanupUploads(files) {
  const uploads = Object.values(files || {}).flat();
  await Promise.allSettled(uploads.map((file) => removeIfPresent(file.path)));
}

function safeMediaPath(directory, filename) {
  if (
    !filename ||
    path.basename(filename) !== filename ||
    !/^[A-Za-z0-9._-]+$/.test(filename)
  ) {
    return null;
  }
  const resolvedDirectory = path.resolve(directory);
  const resolved = path.resolve(resolvedDirectory, filename);
  if (!resolved.startsWith(`${resolvedDirectory}${path.sep}`)) return null;
  return resolved;
}

module.exports = {
  cleanupUploads,
  moveUpload,
  normalizedExtension,
  removeIfPresent,
  safeMediaPath,
  safeStem,
  uploadFilter,
  validateUpload,
};
