"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS magazines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    issue_label TEXT,
    issue_date TEXT,
    pdf_filename TEXT NOT NULL,
    original_pdf_filename TEXT NOT NULL,
    cover_filename TEXT,
    page_count INTEGER,
    is_published INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS magazines_public_order
    ON magazines (is_published, issue_date DESC, created_at DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sessions_expiry
    ON sessions (expires_at);
`;

function ensureDataDirectories(dataDir) {
  const paths = {
    data: dataDir,
    pdfs: path.join(dataDir, "uploads", "pdfs"),
    covers: path.join(dataDir, "uploads", "covers"),
    temp: path.join(dataDir, "uploads", "tmp"),
  };

  Object.values(paths).forEach((directory) => {
    fs.mkdirSync(directory, { recursive: true });
  });

  return paths;
}

function openDatabase(dataDir) {
  const paths = ensureDataDirectories(dataDir);
  const db = new Database(path.join(dataDir, "magshelf.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return { db, paths };
}

module.exports = { openDatabase, ensureDataDirectories };
