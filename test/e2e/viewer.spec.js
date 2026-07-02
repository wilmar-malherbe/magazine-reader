"use strict";

const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const fixturePath = path.join(os.tmpdir(), "magshelf-e2e-magazine.pdf");

test("library, admin, and reader adapt to the viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/admin/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("playwright-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  if (
    await page
      .getByRole("heading", { name: "Responsive Magazine" })
      .count()
  ) {
    // A previous project already populated the shared persistence directory.
  } else {
    await page.getByLabel(/Title/).fill("Responsive Magazine");
    await page.getByLabel("Issue label").fill("July 2026");
    await page.getByLabel(/PDF magazine/).setInputFiles(fixturePath);
    await page.getByRole("button", { name: "Add magazine" }).click();
  }

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Responsive Magazine" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Read issue" }).click();
  await expect(page.locator("#viewer-loading")).toBeHidden();
  await expect(page.locator(".page-surface.is-rendered")).not.toHaveCount(0);

  const expectedOrientation =
    testInfo.project.name === "phone" ? "portrait" : "landscape";
  await expect(page.locator("#magazine-viewer")).toHaveAttribute(
    "data-orientation",
    expectedOrientation,
  );

  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.locator("#magazine-viewer")).not.toHaveAttribute(
    "data-current-page",
    "1",
  );
  const currentPage = await page
    .locator("#magazine-viewer")
    .getAttribute("data-current-page");

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.locator("#zoom-status")).toHaveText("125%");

  await page.setViewportSize(
    testInfo.project.name === "desktop"
      ? { width: 900, height: 1200 }
      : { width: 844, height: 390 },
  );
  await expect(page.locator("#magazine-viewer")).toHaveAttribute(
    "data-current-page",
    currentPage,
  );

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await expect(page.locator(".viewer-toolbar")).toBeVisible();
});
