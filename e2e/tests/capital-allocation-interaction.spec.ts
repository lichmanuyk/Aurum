import { test, expect } from "../fixtures";
import { createTransaction, getDefaultAccountId } from "./helpers";

// See docs/tasks/capital-allocation-interaction.md: the capital allocation
// bar (AssetAllocationCard) sorts its segments/legend/rows descending by
// value, and reuses chartSelection (PR #42) for row<->segment hover/
// keyboard/pin sync — same mechanism as the donut+list pairs, minus the
// connector line (a bar has no sector to point one at). AssetsTable ("Мои
// активы") is a different level (individual manual assets, not classes) —
// it only needs to sort by each asset's own capital_value equivalent, with
// no interactive highlighting at all (see the task doc's own scoping note).

const BASE_URL = process.env.AURUM_E2E_BASE_URL ?? "http://localhost:3100";

async function isolate(request: import("@playwright/test").APIRequestContext) {
  const snapshot = await (await request.get("/api/backup/export")).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]: [string, unknown]) =>
    [key, Array.isArray(value) && !["accounts", "categories"].includes(key) ? [] : value]));
  expect((await request.post("/api/backup/import", { data: empty })).ok()).toBeTruthy();
  return async () => {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  };
}

async function makeAsset(request: import("@playwright/test").APIRequestContext, fields: Record<string, unknown>) {
  const response = await request.post("/api/assets", { data: { asset_class: "other", currency: "USD", value: "0", as_of_date: "2024-06-01", ...fields } });
  expect(response.ok(), `create asset failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function rate(request: import("@playwright/test").APIRequestContext, base: string, quote: string, value: string, day = new Date().toISOString().slice(0, 10)) {
  const response = await request.post("/api/fx-rates/bulk", { data: { items: [{ base_currency: base, quote_currency: quote, rate_date: day, rate: value }] } });
  expect(response.ok()).toBeTruthy();
}

test("allocation bar/legend/rows share one descending order, and hover/keyboard/click sync row<->segment", async ({ page, request }) => {
  const restore = await isolate(request);
  try {
    const accountId = await getDefaultAccountId(request);
    await createTransaction(request, { account_id: accountId, type: "income", amount: "100.00", description: "cash-seed", date: "2024-06-01" });
    await makeAsset(request, { name: "Big investments", asset_class: "investments", value: "300", as_of_date: "2024-06-01" });
    await makeAsset(request, { name: "Small crypto", asset_class: "crypto", value: "50", as_of_date: "2024-06-01" });

    await page.goto("/net-worth");
    const card = page.locator("div.rounded-xl", { has: page.getByText(/^Активы/) }).first();
    const bar = card.locator("div.rounded-full").first();
    const rowsList = card.locator("ul").nth(1); // legend is the first <ul>, detail rows the second
    const legend = card.locator("ul").first();
    // evaluateAll doesn't auto-wait like an expect(...) assertion does —
    // without this, it can run before the summary/assets queries resolve
    // and see an empty/loading card.
    await expect(bar.getByRole("button", { name: /Инвестиции/ })).toBeVisible();

    // Investments (300) > Cash (100) > Crypto (50) — not the backend's own
    // fixed API order (cash, then AssetClass enum order).
    const segmentOrder = await bar.locator('[role="button"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    expect(segmentOrder[0]).toMatch(/^Инвестиции/);
    expect(segmentOrder[1]).toMatch(/^Счета/);
    expect(segmentOrder[2]).toMatch(/^Криптовалюта/);
    const legendOrder = await legend.locator("li").evaluateAll((els) => els.map((el) => el.textContent));
    expect(legendOrder[0]).toContain("Инвестиции");
    expect(legendOrder[1]).toContain("Счета");
    expect(legendOrder[2]).toContain("Криптовалюта");
    const rowOrder = await rowsList.locator("button").evaluateAll((els) => els.map((el) => el.textContent));
    expect(rowOrder[0]).toContain("Инвестиции");
    expect(rowOrder[1]).toContain("Счета");
    expect(rowOrder[2]).toContain("Криптовалюта");

    const rowInvestments = rowsList.getByRole("button", { name: /Инвестиции/ });
    const rowCrypto = rowsList.getByRole("button", { name: /Криптовалюта/ });
    const segmentInvestments = bar.getByRole("button", { name: /^Инвестиции,/ });

    await rowInvestments.hover();
    await expect(rowInvestments).toHaveClass(/bg-surface-2/);
    await expect(rowCrypto).toHaveClass(/opacity-40/);
    await expect(segmentInvestments).not.toHaveAttribute("style", /opacity: 0\.35/);
    await page.mouse.move(0, 0);
    await expect(rowInvestments).not.toHaveClass(/bg-surface-2/);

    // The *segment* driving the row the other way around.
    await segmentInvestments.hover();
    await expect(rowInvestments).toHaveClass(/bg-surface-2/);
    await page.mouse.move(0, 0);

    await rowInvestments.focus();
    await expect(rowInvestments).toHaveClass(/bg-surface-2/);
    await rowInvestments.blur();
    await expect(rowInvestments).not.toHaveClass(/bg-surface-2/);

    await rowInvestments.click();
    await expect(rowInvestments).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(rowInvestments).toHaveAttribute("aria-pressed", "false");

    // A segmented bar, not a donut — no connector line ever renders here,
    // even while something is actively hovered.
    await rowInvestments.hover();
    await expect(card.locator("svg line")).toHaveCount(0);
  } finally {
    await restore();
  }
});

test("a real touch tap pins/unpins an allocation row without leaving artificial hover behind", async ({ browser, request }) => {
  const restore = await isolate(request);
  try {
    const accountId = await getDefaultAccountId(request);
    await createTransaction(request, { account_id: accountId, type: "income", amount: "100.00", description: "cash-seed", date: "2024-06-01" });
    await makeAsset(request, { name: "Tap investments", asset_class: "investments", value: "50", as_of_date: "2024-06-01" });

    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 375, height: 900 },
      hasTouch: true,
      storageState: { cookies: [], origins: [{ origin: new URL(BASE_URL).origin, localStorage: [{ name: "aurum:noAuthAcknowledged", value: "1" }] }] },
    });
    try {
      const page = await context.newPage();
      await page.route("**/api/fx-rates/nbp/latest", (route) => route.fulfill({ json: { saved: 0, absent_currencies: [] } }));
      await page.goto("/net-worth");

      const card = page.locator("div.rounded-xl", { has: page.getByText(/^Активы/) }).first();
      const rowsList = card.locator("ul").nth(1);
      const rowCash = rowsList.getByRole("button", { name: /Счета/ });
      const rowInvestments = rowsList.getByRole("button", { name: /Инвестиции/ });

      await rowCash.tap();
      await expect(rowCash).toHaveAttribute("aria-pressed", "true");
      await expect(rowCash).toHaveClass(/bg-surface-2/);
      await expect(rowInvestments).toHaveClass(/opacity-40/);

      await rowCash.tap();
      await expect(rowCash).toHaveAttribute("aria-pressed", "false");
      await expect(rowCash).not.toHaveClass(/bg-surface-2/);
      await expect(rowInvestments).not.toHaveClass(/opacity-40/);
    } finally {
      await context.close();
    }
  } finally {
    await restore();
  }
});

test("assets table orders by capital equivalent (not native amount) across currencies, and shows zero/missing-valuation/missing-FX explicitly", async ({ page, request }) => {
  const restore = await isolate(request);
  try {
    await request.patch("/api/settings", { data: { currency: "USD" } });
    await rate(request, "EUR", "USD", "1.10");
    await rate(request, "PLN", "USD", "0.25");
    // Native amounts (10 vs 20) would rank "Small EUR real value" behind
    // "Big PLN native only" — its actual capital equivalent (11) is larger.
    await makeAsset(request, { name: "Small EUR real value", currency: "EUR", value: "10" });
    await makeAsset(request, { name: "Big PLN native only", currency: "PLN", value: "20" });
    await makeAsset(request, { name: "Real zero", currency: "USD", value: "0" });
    await makeAsset(request, { name: "Not valued yet", currency: "USD", value: "500", as_of_date: "2999-01-01" });
    await makeAsset(request, { name: "No FX rate", currency: "GBP", value: "10" });

    await page.goto("/net-worth");
    const assetsCard = page.locator("div.rounded-xl", { has: page.getByText("Мои активы", { exact: true }) });
    // evaluateAll doesn't auto-wait — make sure the list has actually
    // rendered (not still "Загрузка…") before reading its order.
    await expect(assetsCard.getByText("No FX rate")).toBeVisible();
    const names = await assetsCard.locator("ul > li .text-sm.font-medium.text-text-primary").evaluateAll((els) => els.map((el) => el.textContent));
    // Valued assets first, ranked by real equivalent — "Small EUR real
    // value" (11 USD) ahead of "Big PLN native only" (5 USD) despite the
    // opposite native-number order; unvalued/unconvertible rows trail,
    // still visible, never dropped.
    expect(names.indexOf("Small EUR real value")).toBeLessThan(names.indexOf("Big PLN native only"));
    expect(names.indexOf("Big PLN native only")).toBeLessThan(names.indexOf("Real zero"));
    expect(names).toContain("Not valued yet");
    expect(names).toContain("No FX rate");

    const zeroRow = assetsCard.locator("li", { hasText: "Real zero" });
    await expect(zeroRow).not.toContainText("нет оценки");
    await expect(zeroRow).not.toContainText("нет курса");
    // A real recorded zero valuation still reads as an actual amount ("0 $"),
    // never the dash reserved for "nothing to convert at all".
    await expect(zeroRow.locator(".text-sm.font-medium.tabular-nums.text-text-primary")).not.toHaveText("—");
    const unvaluedRow = assetsCard.locator("li", { hasText: "Not valued yet" });
    await expect(unvaluedRow).toContainText("нет оценки");
    // A never-valued asset shows a dash, not a monetary "0" that would read
    // as a real (if tiny) valuation.
    await expect(unvaluedRow.locator(".text-sm.font-medium.tabular-nums.text-text-primary")).toHaveText("—");
    const noRateRow = assetsCard.locator("li", { hasText: "No FX rate" });
    await expect(noRateRow).toContainText("нет курса");
    await expect(noRateRow).not.toContainText("нет оценки");
    // The native amount is known even though its capital-currency equivalent
    // isn't — only the missing rate is a dash-free "нет курса" label below.
    await expect(noRateRow.locator(".text-sm.font-medium.tabular-nums.text-text-primary")).toContainText("10");

    // The equivalent line is only shown when it adds information over the
    // native amount already displayed.
    const convertedRow = assetsCard.locator("li", { hasText: "Small EUR real value" });
    await expect(convertedRow).toContainText("в капитале");

    // Financial actions on this table are untouched by any of the above.
    await convertedRow.getByRole("button", { name: "Изменить" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally {
    await restore();
  }
});

test("switching Net Worth's own display currency updates the equivalent, not a stale figure from before the switch", async ({ page, request }) => {
  const restore = await isolate(request);
  try {
    await request.patch("/api/settings", { data: { currency: "USD", net_worth_currency: null } });
    await rate(request, "EUR", "USD", "1.10");
    await rate(request, "EUR", "PLN", "4.00");
    await makeAsset(request, { name: "Currency switch asset", currency: "EUR", value: "10" });

    await page.goto("/net-worth");
    const assetsCard = page.locator("div.rounded-xl", { has: page.getByText("Мои активы", { exact: true }) });
    const row = assetsCard.locator("li", { hasText: "Currency switch asset" });
    await expect(row).toContainText("11");
    await expect(row).not.toContainText("40,00");

    await request.patch("/api/settings", { data: { net_worth_currency: "PLN" } });
    await page.reload();
    await expect(row).toContainText("40");
    await expect(row).not.toContainText("≈ 11");
  } finally {
    await restore();
  }
});
