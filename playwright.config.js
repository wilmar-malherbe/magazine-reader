"use strict";

const path = require("node:path");
const os = require("node:os");
const { defineConfig } = require("@playwright/test");

const dataDir = path.join(os.tmpdir(), "magshelf-playwright-data");

module.exports = defineConfig({
  testDir: "./test/e2e",
  globalSetup: require.resolve("./test/e2e/global-setup"),
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:3310",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node test/e2e/start-server.js",
    url: "http://127.0.0.1:3310",
    reuseExistingServer: false,
    env: {
      ...process.env,
      APP_NAME: "MagShelf E2E",
      PORT: "3310",
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: "http://127.0.0.1:3310",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "playwright-password",
      SESSION_SECRET: "playwright-session-secret-for-local-e2e-tests",
      MAX_UPLOAD_MB: "10",
      ALLOW_PUBLIC_DOWNLOAD: "true",
    },
  },
  projects: [
    {
      name: "phone",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "tablet",
      use: {
        browserName: "chromium",
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
