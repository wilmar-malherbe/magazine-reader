"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

module.exports = async function globalSetup() {
  const fixturePath = path.join(os.tmpdir(), "magshelf-e2e-magazine.pdf");

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let index = 0; index < 6; index += 1) {
    const page = pdf.addPage([600, 800]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 600,
      height: 800,
      color: index % 2 ? rgb(0.9, 0.94, 0.95) : rgb(0.97, 0.9, 0.84),
    });
    page.drawText(`Responsive Magazine — Page ${index + 1}`, {
      x: 48,
      y: 690,
      size: 27,
      font,
      color: rgb(0.2, 0.2, 0.25),
    });
  }
  fs.writeFileSync(fixturePath, await pdf.save());
}
