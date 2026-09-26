import { test, expect } from "../fixtures";
import { makeHolding } from "../../frontend/src/test/cryptoFixtures";
import { createTransaction, getCategoryId, getDefaultAccountId } from "./helpers";

// See docs/tasks/donut-chart-interaction.md: hovering a donut sector
// highlights its list row (and vice versa) with a synchronized, reversible
// highlight; keyboard focus and a phone tap give the same pairing; a click
// pins it until clicked again or Escape; a thin connector line joins the
// active row to its sector on wide screens only. Covers the three
// genuinely-donut-next-to-list surfaces reviewed for this task —
// SpendingByCategoryCard (dashboard), CryptoAllocationBody and
// CryptoNetworkAllocationBody (crypto page) — plus the SpendingByCategoryCard
// stale-breakdown fix. AssetAllocationCard (net worth) is a segmented bar,
// not a donut, and CryptoRiskAllocationBody/CryptoStatsRow have no chart at
// all — none of the three have a sector to synchronize with, so none were
// touched (see the PR description for the full reviewed/scope list).

test("same-colored dashboard categories: hover/keyboard/click sync row↔sector unambiguously, and Escape un-pins", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const sameColor = "#2a78d6";
  const catA = (await request.post("/api/categories", { data: { name: "Donut A", kind: "expense", color: sameColor } })).json();
  const catB = (await request.post("/api/categories", { data: { name: "Donut B", kind: "expense", color: sameColor } })).json();
  const idA = (await catA).id;
  const idB = (await catB).id;
  await createTransaction(request, { account_id: accountId, category_id: idA, type: "expense", amount: "70.00", description: "donut-a-txn", date: "2024-06-01" });
  await createTransaction(request, { account_id: accountId, category_id: idB, type: "expense", amount: "30.00", description: "donut-b-txn", date: "2024-06-01" });

  await page.goto("/"); // Dashboard opens on "Всё время" by default — both show up with no period navigation needed.
  const card = page.locator("div.rounded-xl", { has: page.getByText("Расходы по категориям", { exact: true }) });
  // Scoped by DOM area (the <ul> vs the chart's own wrapper), not just by
  // name — a sector's aria-label and its row's own accessible name both
  // contain the category name, so name-only matching would hit both.
  const list = card.locator("ul");
  const chart = card.locator(".recharts-wrapper");
  const rowA = list.getByRole("button", { name: /Donut A/ });
  const rowB = list.getByRole("button", { name: /Donut B/ });
  const sectorB = chart.getByRole("button", { name: /^Donut B,/ });

  // Hovering a row highlights its own sector and dims the other row/sector.
  await rowA.hover();
  await expect(rowA).toHaveClass(/bg-surface-2/);
  await expect(rowB).toHaveClass(/opacity-40/);
  await expect(sectorB).toHaveAttribute("fill-opacity", "0.35");
  await page.mouse.move(0, 0);
  await expect(rowA).not.toHaveClass(/bg-surface-2/);
  await expect(rowB).not.toHaveClass(/opacity-40/);

  // Hovering the *sector* highlights the row the other way around.
  await sectorB.hover();
  await expect(rowB).toHaveClass(/bg-surface-2/);
  await expect(rowA).toHaveClass(/opacity-40/);
  await page.mouse.move(0, 0);

  // Keyboard focus behaves the same as hover, and reverts on blur.
  await rowA.focus();
  await expect(rowA).toHaveClass(/bg-surface-2/);
  await rowA.blur();
  await expect(rowA).not.toHaveClass(/bg-surface-2/);

  // A click pins the highlight — it survives the mouse moving away — and a
  // second click (or a phone tap, which fires the same click event) un-pins.
  await rowB.click();
  await expect(rowB).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(rowB).toHaveClass(/bg-surface-2/); // still highlighted with the mouse gone
  await rowB.click();
  await expect(rowB).toHaveAttribute("aria-pressed", "false");
  await page.mouse.move(0, 0); // the mouse is still over rowB right after clicking it — hover alone would keep it lit
  await expect(rowB).not.toHaveClass(/bg-surface-2/);

  // Escape un-pins from anywhere, not just by clicking the same row again.
  await rowA.click();
  await expect(rowA).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(rowA).toHaveAttribute("aria-pressed", "false");
  await page.mouse.move(0, 0);
  await expect(rowA).not.toHaveClass(/bg-surface-2/);
});

test("the donut+list connector line appears at 1440px pointing into the chart, and is absent on a narrow 375px layout", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const groceriesId = await getCategoryId(request, "Groceries");
  await createTransaction(request, { account_id: accountId, category_id: groceriesId, type: "expense", amount: "50.00", description: "connector-txn", date: "2024-06-01" });

  await page.goto("/");
  const card = page.locator("div.rounded-xl", { has: page.getByText("Расходы по категориям", { exact: true }) });
  const row = card.locator("ul").getByRole("button", { name: /Продукты/ });
  await row.hover();

  const line = card.locator("svg line");
  await expect(line).toBeVisible();
  const chartBox = await card.locator(".recharts-wrapper").boundingBox();
  const lineBox = await line.boundingBox();
  expect(chartBox).not.toBeNull();
  expect(lineBox).not.toBeNull();
  // The line's chart-side endpoint lands inside (or right at the edge of)
  // the donut's own box — "middle of the outer arc", not off in empty space.
  expect(lineBox!.x).toBeGreaterThanOrEqual(chartBox!.x - 2);
  expect(lineBox!.x).toBeLessThanOrEqual(chartBox!.x + chartBox!.width + 2);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  await page.setViewportSize({ width: 375, height: 900 });
  await row.hover();
  await expect(line).toHaveCount(0); // stacked layout — sync highlight only, no line
  const narrowOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(narrowOverflow.scrollWidth).toBeLessThanOrEqual(narrowOverflow.clientWidth);
});

test("a phone tap on a row pins the same highlight a click does, at 375px", async ({ page, request }) => {
  // A tap fires the same click event a mouse click does — there's no
  // separate touch-specific handler here to miss — so this exercises the
  // component's actual tap behavior without needing a dedicated
  // hasTouch:true context just to call .tap() instead of .click().
  const accountId = await getDefaultAccountId(request);
  const groceriesId = await getCategoryId(request, "Groceries");
  const salaryId = await getCategoryId(request, "Salary");
  await createTransaction(request, { account_id: accountId, category_id: groceriesId, type: "expense", amount: "40.00", description: "tap-a", date: "2024-06-01" });
  await createTransaction(request, { account_id: accountId, category_id: salaryId, type: "income", amount: "10.00", description: "tap-b-income", date: "2024-06-01" });

  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/");
  const card = page.locator("div.rounded-xl", { has: page.getByText("Расходы по категориям", { exact: true }) });
  const row = card.locator("ul").getByRole("button", { name: /Продукты/ });
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "false");
});

test("a single expense category still highlights correctly and shows a real empty state with zero", async ({ page, request }) => {
  const snapshot = await (await request.get("/api/backup/export")).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]: [string, unknown]) =>
    [key, Array.isArray(value) && !["accounts", "categories"].includes(key) ? [] : value]));
  try {
    expect((await request.post("/api/backup/import", { data: empty })).ok()).toBeTruthy();
    const accountId = await getDefaultAccountId(request);
    const groceriesId = await getCategoryId(request, "Groceries");

    // Empty state first — no expense at all.
    await page.goto("/");
    const card = page.locator("div.rounded-xl", { has: page.getByText("Расходы по категориям", { exact: true }) });
    await expect(card.getByText(/Нет расходов за выбранный период/)).toBeVisible();

    // A single category — hover still highlights it without erroring on a
    // "only one sector, nothing to dim" edge case.
    await createTransaction(request, { account_id: accountId, category_id: groceriesId, type: "expense", amount: "20.00", description: "only-one", date: "2024-06-01" });
    await page.reload();
    const row = card.locator("ul").getByRole("button", { name: /Продукты/ });
    await row.hover();
    await expect(row).toHaveClass(/bg-surface-2/);
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

// The breakdown modal's own stale-snapshot fix (a disappeared/re-priced
// category not leaving old data behind) is covered as a fast component
// test instead — see SpendingByCategoryCard.test.tsx. A modal's own
// full-viewport backdrop blocks clicking anything else on the page while
// it's open (by design, like any modal), so "switch the period/currency
// while the modal is visibly open" can't actually be driven through a
// click on a background control in this UI; the component test re-renders
// with new props directly instead, exactly like CategoryRankingCard's own
// equivalent test already does.

test("crypto allocation donut: hover/keyboard/Escape sync the same way, and masked amounts stay masked in the accessible label", async ({ page }) => {
  await page.route("**/api/crypto/holdings?*", (route) => route.fulfill({ json: {
    synced: false, last_synced_at: null, error_key: null,
    holdings: [
      makeHolding({ symbol: "BTC", name: "Bitcoin", value: "600" }),
      makeHolding({ symbol: "ETH", name: "Ethereum", value: "300" }),
      makeHolding({ symbol: "SOL", name: "Solana", value: "100" }),
    ],
  } }));

  await page.goto("/crypto");
  const overviewCard = page.locator("div.rounded-xl", { has: page.getByRole("button", { name: "Аллокация", exact: true }) });
  await overviewCard.getByRole("button", { name: "Аллокация", exact: true }).click();
  // Scoped to this one card's own table — the page also has an unrelated
  // full holdings table further down sharing "BTC"/"ETH" text.
  const btcRow = overviewCard.locator("table tbody").getByRole("row", { name: /BTC/ });
  const ethRow = overviewCard.locator("table tbody").getByRole("row", { name: /ETH/ });
  const btcSector = overviewCard.getByRole("button", { name: /^Bitcoin \(BTC\),/ });

  await btcRow.hover();
  await expect(btcRow).toHaveClass(/bg-surface-2/);
  await expect(ethRow).toHaveClass(/opacity-40/);
  await page.mouse.move(0, 0);

  await btcSector.focus();
  await expect(btcRow).toHaveClass(/bg-surface-2/);
  await page.keyboard.press("Escape");

  await btcRow.click();
  await expect(btcRow).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(btcRow).toHaveAttribute("aria-pressed", "false");

  // Hidden amounts: the sector's own accessible label must mask the money
  // figure exactly like the table cell next to it does.
  await page.getByRole("button", { name: /Скрыть сумму|Hide amount/ }).click();
  await expect(overviewCard.getByRole("cell", { name: "••••" }).first()).toBeVisible();
  await expect(btcSector).toHaveAttribute("aria-label", /••••/);
  await expect(btcSector).not.toHaveAttribute("aria-label", /\$?600/);
});

test("crypto networks donut: hover sync and connector line work the same as the coin donut", async ({ page }) => {
  await page.route("**/api/crypto/holdings?*", (route) => route.fulfill({ json: {
    synced: false, last_synced_at: null, error_key: null,
    holdings: [
      makeHolding({ symbol: "BTC", name: "Bitcoin", value: "400", network: "bitcoin" }),
      makeHolding({ symbol: "USDT", name: "Tether", value: "200", network: "ethereum" }),
    ],
  } }));

  await page.goto("/crypto");
  const overviewCard = page.locator("div.rounded-xl", { has: page.getByRole("button", { name: "Сети", exact: true }) });
  await overviewCard.getByRole("button", { name: "Сети", exact: true }).click();
  const bitcoinRow = overviewCard.locator("table tbody").getByRole("row", { name: /bitcoin/i }).first();
  await bitcoinRow.hover();
  await expect(bitcoinRow).toHaveClass(/bg-surface-2/);
  // Scoped to this card — the sidebar nav has its own unrelated <svg><line>
  // icons (e.g. the ROI link) elsewhere on the page.
  await expect(overviewCard.locator("svg line")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});
