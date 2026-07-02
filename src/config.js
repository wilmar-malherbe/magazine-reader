"use strict";

const path = require("node:path");

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function booleanValue(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be either "true" or "false"`);
}

function loadConfig(env = process.env) {
  const publicBaseUrl = required(env, "PUBLIC_BASE_URL");
  try {
    new URL(publicBaseUrl);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid absolute URL");
  }

  return Object.freeze({
    appName: env.APP_NAME?.trim() || "MagShelf",
    port: positiveInteger(required(env, "PORT"), "PORT"),
    dataDir: path.resolve(required(env, "DATA_DIR")),
    publicBaseUrl,
    adminUsername: required(env, "ADMIN_USERNAME"),
    adminPassword: required(env, "ADMIN_PASSWORD"),
    sessionSecret: required(env, "SESSION_SECRET"),
    maxUploadMb: positiveInteger(env.MAX_UPLOAD_MB || "500", "MAX_UPLOAD_MB"),
    allowPublicDownload: booleanValue(
      env.ALLOW_PUBLIC_DOWNLOAD,
      "ALLOW_PUBLIC_DOWNLOAD",
      true,
    ),
  });
}

module.exports = { loadConfig };
