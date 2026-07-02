"use strict";

const crypto = require("node:crypto");

function constantTimeEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left)).digest();
  const rightDigest = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function credentialsMatch(config, username, password) {
  return (
    constantTimeEqual(username, config.adminUsername) &&
    constantTimeEqual(password, config.adminPassword)
  );
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  req.session.returnTo = req.originalUrl;
  return res.redirect("/admin/login");
}

function isAdmin(req) {
  return Boolean(req.session?.isAdmin);
}

module.exports = { credentialsMatch, requireAdmin, isAdmin };
