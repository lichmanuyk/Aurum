import { test, expect } from "../fixtures";

// Regression for v0.17.1: Net Worth defaulted to a 30-day window, which
// frequently shows a dip just from short-window noise even when the
// long-run trend is a climb — demotivating for no good reason. Should
// default to 5 years instead. See UPDATES.md (v0.17.1) and
// frontend/src/pages/NetWorthPage.tsx.
test("Net Worth opens with the 5Y range active, not 30D", async ({ page }) => {
  await page.goto("/net-worth");

  const fiveYearButton = page.getByRole("button", { name: "5Y", exact: true });
  const thirtyDayButton = page.getByRole("button", { name: "30D", exact: true });
  await expect(fiveYearButton).toBeVisible();

  const fiveYearClass = await fiveYearButton.getAttribute("class");
  const thirtyDayClass = await thirtyDayButton.getAttribute("class");
  expect(fiveYearClass).toContain("bg-surface-2");
  expect(thirtyDayClass).not.toContain("bg-surface-2");
});
