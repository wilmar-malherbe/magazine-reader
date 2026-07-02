"use strict";

require("dotenv").config();

const { createApp } = require("./src/app");
const { loadConfig } = require("./src/config");

function start() {
  try {
    const config = loadConfig();
    const app = createApp(config);
    const server = app.listen(config.port, () => {
      console.log(`${config.appName} is listening on port ${config.port}`);
    });

    const shutdown = () => {
      server.close(() => {
        app.locals.resources.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(`Unable to start MagShelf: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) start();

module.exports = { start };
