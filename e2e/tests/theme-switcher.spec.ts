import { test, expect } from "../fixtures";

// The theme picker (Settings → Тема оформления): light/dark/system, with
// system meant to follow the OS live and light/dark meant to override it.
// See frontend/src/lib/theme.ts and index.html's anti-FOUC inline script.

async function surface0(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim());
}

test.describe("theme picker", () => {
  test.use({ colorScheme: "dark" }); // simulates the OS being in dark mode

  test("an explicit choice overrides the OS theme, and persists across reload", async ({ page }) => {
    await page.goto("/settings");
    await expect(await surface0(page)).toBe("#0d0d0d"); // "system" follows the dark OS by default

    await page.getByRole("button", { name: "Светлая", exact: true }).click();
    await expect(await surface0(page)).toBe("#f9f9f7"); // forced light despite the dark OS

    await page.reload();
    await expect(await surface0(page)).toBe("#f9f9f7"); // survives a reload, not just in-memory state

    await page.getByRole("button", { name: "Системная", exact: true }).click();
    await expect(await surface0(page)).toBe("#0d0d0d"); // back to following the (still-dark) OS
  });

  test("switching back to system never leaves a stale forced theme behind", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Тёмная", exact: true }).click();
    await page.getByRole("button", { name: "Системная", exact: true }).click();
    const dataTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(dataTheme).toBeNull();
  });
});
