"use strict";

const session = require("express-session");

class BetterSqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.statements = {
      get: db.prepare(
        "SELECT data, expires_at FROM sessions WHERE sid = ? LIMIT 1",
      ),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           data = excluded.data,
           expires_at = excluded.expires_at`,
      ),
      destroy: db.prepare("DELETE FROM sessions WHERE sid = ?"),
      touch: db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?"),
      clear: db.prepare("DELETE FROM sessions"),
      length: db.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?",
      ),
      prune: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    };
  }

  expiry(sessionData) {
    const cookieExpiry = sessionData.cookie?.expires;
    const timestamp = cookieExpiry ? new Date(cookieExpiry).getTime() : NaN;
    return Number.isFinite(timestamp)
      ? timestamp
      : Date.now() + 12 * 60 * 60 * 1000;
  }

  get(sid, callback) {
    try {
      const row = this.statements.get.get(sid);
      if (!row || row.expires_at <= Date.now()) {
        if (row) this.statements.destroy.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      this.statements.prune.run(Date.now());
      this.statements.set.run(
        sid,
        JSON.stringify(sessionData),
        this.expiry(sessionData),
      );
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      this.statements.touch.run(this.expiry(sessionData), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.statements.destroy.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.statements.clear.run();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  length(callback) {
    try {
      callback(null, this.statements.length.get(Date.now()).count);
    } catch (error) {
      callback(error);
    }
  }
}

module.exports = { BetterSqliteSessionStore };
