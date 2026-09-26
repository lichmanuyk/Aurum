import { test, expect } from "../fixtures";
import { createTransaction, getCategoryId, getDefaultAccountId } from "./helpers";

// Regression for v0.15.4: a transaction description with no spaces (so it
// can't wrap) blew out the Dashboard's CSS Grid because Card had no
// min-width: 0, growing the whole page wider than the viewport instead of
// letting `truncate` ellipsize the text. See UPDATES.md (v0.15.4) and
// frontend/src/components/ui/Card.tsx.
const LONG_DESCRIPTION =
  "оченьдлинноеописаниебезпробеловкотороедолжнообрезатьсямноготочиемачтобынеломатьверсткукарточкинадашборде1234567890";

test("a long unbroken transaction description never causes horizontal page overflow", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const categoryId = await getCategoryId(request, "Groceries");
  await createTransaction(request, {
    account_id: accountId,
    category_id: categoryId,
    type: "expense",
    amount: "12.34",
    description: LONG_DESCRIPTION,
    date: "2016-08-01",
  });

  await page.goto("/");
  // Fresh open defaults to "Всё время" — switch to "Год" mode first to
  // reveal the month/year pickers at all (see docs/tasks/dashboard-periods.md).
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2016" }).click();
  await page.getByRole("button", { name: "Авг", exact: true }).click();
  await expect(page.getByText(LONG_DESCRIPTION.slice(0, 20), { exact: false })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});

test("same check on a narrow mobile viewport", async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const accountId = await getDefaultAccountId(request);
  const categoryId = await getCategoryId(request, "Groceries");
  await createTransaction(request, {
    account_id: accountId,
    category_id: categoryId,
    type: "expense",
    amount: "12.34",
    description: LONG_DESCRIPTION,
    date: "2016-09-01",
  });

  await page.goto("/");
  // Fresh open defaults to "Всё время" — switch to "Год" mode first to
  // reveal the month/year pickers at all (see docs/tasks/dashboard-periods.md).
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2016" }).click();
  await page.getByRole("button", { name: "Сен", exact: true }).click();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});
