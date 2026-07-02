"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const multer = require("multer");
const { uploadFilter } = require("./files");

function createUploadMiddleware(config, paths) {
  const storage = multer.diskStorage({
    destination: paths.temp,
    filename(req, file, callback) {
      callback(
        null,
        `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${path
          .extname(file.originalname)
          .toLowerCase()}`,
      );
    },
  });

  return multer({
    storage,
    fileFilter: uploadFilter,
    limits: {
      fileSize: config.maxUploadMb * 1024 * 1024,
      files: 2,
      fields: 20,
    },
  }).fields([
    { name: "pdf", maxCount: 1 },
    { name: "cover", maxCount: 1 },
  ]);
}

module.exports = { createUploadMiddleware };
