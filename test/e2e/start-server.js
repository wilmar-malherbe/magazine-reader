"use strict";

const fs = require("node:fs");

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
require("../../server").start();
