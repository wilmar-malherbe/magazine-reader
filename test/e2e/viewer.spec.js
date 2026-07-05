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

  const isDesktop = testInfo.project.name === "desktop";
  const layoutDialog = page.getByRole("dialog", {
    name: "How would you like to read?",
  });
  const spreadChoice = layoutDialog.getByRole("button", {
    name: /2 pages/,
  });

  if (isDesktop) {
    await expect(layoutDialog).toBeVisible();
    await expect(spreadChoice).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(layoutDialog).toBeVisible();
    await page.keyboard.press("Enter");
  } else {
    await expect(layoutDialog).not.toBeVisible();
  }

  await expect(page.locator("#viewer-loading")).toBeHidden();
  await expect(page.locator(".page-surface.is-rendered")).not.toHaveCount(0);

  const expectedOrientation = isDesktop ? "landscape" : "portrait";
  await expect(page.locator("#magazine-viewer")).toHaveAttribute(
    "data-orientation",
    expectedOrientation,
  );
  await expect(page.locator("#magazine-viewer")).toHaveAttribute(
    "data-layout",
    isDesktop ? "spread" : "single",
  );
  if (isDesktop) {
    await expect(page.locator("#layout-switch")).toBeVisible();
  } else {
    await expect(page.locator("#layout-switch")).toBeHidden();
  }

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

  if (isDesktop) {
    await page.getByRole("button", { name: "Show one page at a time" }).click();
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-layout",
      "single",
    );
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-orientation",
      "portrait",
    );
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-current-page",
      currentPage,
    );
    await expect(page.locator("#zoom-status")).toHaveText("125%");

    await page.getByRole("button", { name: "Show a two-page spread" }).click();
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-layout",
      "spread",
    );
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-orientation",
      "landscape",
    );

    await page.setViewportSize({ width: 900, height: 1200 });
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-layout",
      "single",
    );
    await expect(page.locator("#layout-switch")).toBeHidden();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-layout",
      "spread",
    );
    await expect(page.locator("#layout-switch")).toBeVisible();
  } else {
    await page.setViewportSize(
      testInfo.project.name === "tablet"
        ? { width: 1180, height: 820 }
        : { width: 844, height: 390 },
    );
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-layout",
      "single",
    );
    await expect(page.locator("#magazine-viewer")).toHaveAttribute(
      "data-orientation",
      "portrait",
    );
    await expect(page.locator("#layout-switch")).toBeHidden();
  }

  await expect(page.locator("#magazine-viewer")).toHaveAttribute(
    "data-current-page",
    currentPage,
  );

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await expect(page.locator(".viewer-toolbar")).toBeVisible();

  if (isDesktop) {
    await page.reload();
    await expect(layoutDialog).toBeVisible();
  }
});
