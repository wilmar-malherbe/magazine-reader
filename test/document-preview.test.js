"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDocumentPreview } = require("../src/document-preview");

test("preview is bounded, cached per revision and fails safely", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magshelf-preview-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "report.pdf");
  await fs.writeFile(file, "sample");
  let calls = 0;
  const preview = createDocumentPreview({ extract: async (command, args, options) => {
    calls++;
    assert.equal(command, "pdftotext");
    assert.deepEqual(args.slice(0, 4), ["-f", "1", "-l", "6"]);
    assert.equal(args.at(-2), file);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 256 * 1024);
    return { stdout: "Actual document text\nwith a line break.\n\nSecond paragraph." };
  }});
  assert.deepEqual(await preview(file), ["Actual document text with a line break.", "Second paragraph."]);
  await preview(file);
  assert.equal(calls, 1);
  await fs.writeFile(file, "a replacement file");
  await preview(file);
  assert.equal(calls, 2);
  assert.equal(await preview(path.join(dir, "missing.pdf")), null);
  assert.equal(await preview(dir), null);
  const failed = createDocumentPreview({ extract: async () => { throw new Error("converter unavailable"); } });
  assert.deepEqual(await failed(file), []);
});
