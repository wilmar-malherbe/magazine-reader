"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const run = promisify(execFile);

// Parse a bounded excerpt once per file revision, never on the browser thread.
// A missing converter or scanned PDF leaves the description/PDF link usable.
function createDocumentPreview({ extract = run } = {}) {
  const cache = new Map();
  let active = 0;
  return async function preview(filePath) {
    let stat;
    try { stat = await fs.stat(filePath); } catch { return null; }
    if (!stat.isFile()) return null;
    const version = `${stat.size}:${stat.mtimeMs}`;
    const cached = cache.get(filePath);
    if (cached?.version === version) return cached.value;
    if (active >= 2) return [];
    active += 1;
    const value = (async () => {
      try {
        const { stdout } = await extract("pdftotext", [
          "-f", "1", "-l", "6", "-enc", "UTF-8", "-nopgbrk", filePath, "-",
        ], { timeout: 5000, maxBuffer: 256 * 1024, killSignal: "SIGKILL" });
        return stdout.replace(/\r/g, "").slice(0, 16000)
          .split(/\n\s*\n/).map(value => value.replace(/\s+/g, " ").trim())
          .filter(Boolean);
      } catch { return []; }
      finally { active -= 1; }
    })();
    cache.delete(filePath);
    cache.set(filePath, { version, value });
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    return value;
  };
}

module.exports = { createDocumentPreview };
