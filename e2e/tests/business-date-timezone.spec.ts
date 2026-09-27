import { test, expect } from "../fixtures";

/** See docs/tasks/business-date-timezone.md. Backend correctness (Warsaw
 * vs UTC, DST, midnight rollover) is covered by
 * backend/tests/test_business_date_timezone.py with a mocked clock —
 * unreachable from here, since this suite talks to a real running backend
 * on the real host clock. What *is* reachable, and specifically requested
 * separately from that backend coverage, is the frontend's own behavior
 * under a browser timezone far from Europe/Warsaw in either direction:
 * this file forces the *browser* (not the server) into Asia/Tokyo (ahead
 * of Warsaw) and America/Los_Angeles (behind Warsaw) and asserts the
 * "today" default shown in a form always matches the server's own
 * GET /api/settings `business_date` — never a value the browser's own
 * `new Date()` would have computed in that timezone. */

async function fetchServerBusinessDate(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const response = await request.get("/api/settings");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.business_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  return body.business_date;
}

for (const timezoneId of ["Asia/Tokyo", "America/Los_Angeles"] as const) {
  test.describe(`browser timezone: ${timezoneId}`, () => {
    test.use({ timezoneId });

    test(`new transaction's date defaults to the server's business date, not a ${timezoneId}-local "today"`, async ({ page, request }) => {
      const serverBusinessDate = await fetchServerBusinessDate(request);

      // What the *old*, buggy client-side default would have produced in
      // this browser timezone — not asserted against directly (Tokyo/LA
      // usually still land on the same calendar day as Warsaw outside the
      // few hours around midnight, so the two could coincidentally match
      // depending on real wall-clock time when this suite happens to run);
      // logged only so a failure's own diff is legible.
      const browserGuessedDate: string = await page.evaluate(() => new Date().toISOString().slice(0, 10));
      test.info().annotations.push({ type: "browser-guessed-date (for context only)", description: browserGuessedDate });

      await page.goto("/transactions");
      await page.getByRole("button", { name: /Добавить|Add/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator("#date")).toHaveValue(serverBusinessDate);
    });

    test(`a new manual asset's valuation date defaults to the server's business date under ${timezoneId} too`, async ({ page, request }) => {
      const serverBusinessDate = await fetchServerBusinessDate(request);
      await page.goto("/net-worth");
      // AssetFormModal (components/networth/AssetFormModal.tsx) uses the
      // exact same useBusinessDate() hook as the transaction form above —
      // checked here too since it's a second, independent call site of it.
      await page.getByRole("button", { name: /Добавить|Add/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator("#asset-date")).toHaveValue(serverBusinessDate);
    });
  });
}

test.describe("business date loading/error states never fabricate a browser date", () => {
  test("a new transaction's date field starts empty (not the browser's date) while /api/settings is still loading, then fills in", async ({ page }) => {
    let releaseSettings: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseSettings = resolve; });
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "GET") {
        await gate;
      }
      await route.continue();
    });

    await page.goto("/transactions");
    await page.getByRole("button", { name: /Добавить|Add/ }).first().click();
    const dialog = page.getByRole("dialog");
    // Still loading — the field must be empty, never a client-guessed date.
    await expect(dialog.locator("#date")).toHaveValue("");
    await expect(dialog.getByText(/Загрузка даты|Loading date/)).toBeVisible();

    releaseSettings!();
    await expect(dialog.locator("#date")).not.toHaveValue("", { timeout: 5000 });
  });

  test("an unavailable business date shows an explicit error and retry, and recovers once the source is back", async ({ page }) => {
    let shouldFail = true;
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "GET" && shouldFail) {
        await route.fulfill({ status: 503, body: "synthetic outage" });
        return;
      }
      await route.continue();
    });

    await page.goto("/transactions");
    await page.getByRole("button", { name: /Добавить|Add/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Не удалось получить дату|Could not get the date/)).toBeVisible();
    await expect(dialog.locator("#date")).toHaveValue("");

    shouldFail = false;
    await dialog.getByRole("button", { name: /Повторить|Retry/ }).click();
    await expect(dialog.locator("#date")).not.toHaveValue("", { timeout: 5000 });
  });
});

test.describe("mobile viewport (375px)", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("new transaction's date still defaults to the server's business date on a narrow phone-width viewport", async ({ page, request }) => {
    const serverBusinessDate = await fetchServerBusinessDate(request);
    await page.goto("/transactions");
    await page.getByRole("button", { name: /Добавить|Add/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("#date")).toHaveValue(serverBusinessDate);
    // The dialog itself stays within the viewport — no horizontal overflow
    // introduced by the new loading/error notice's own markup.
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(375);
  });

  test("Cash Flow's default 'Этот год' period resolves to a real, enabled period on a narrow viewport — never stuck disabled/mislabeled", async ({ page }) => {
    await page.goto("/cash-flow");
    // "Этот год" is the default-selected pill from first paint (see
    // pages/CashFlowPage.tsx) but starts *disabled* (see
    // DATE_DEPENDENT_RANGE_PRESETS) until the business date resolves —
    // asserting it becomes enabled is exactly "resolved to a real period,
    // not stuck showing unbounded 'Всё время' data under this label".
    const thisYearPill = page.getByRole("button", { name: "Этот год", exact: true });
    await expect(thisYearPill).toBeVisible();
    await expect(thisYearPill).toBeEnabled({ timeout: 5000 });
  });
});
