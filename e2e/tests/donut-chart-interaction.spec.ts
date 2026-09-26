import type { Locator } from "@playwright/test";
import { test, expect } from "../fixtures";
import { makeHolding } from "../../frontend/src/test/cryptoFixtures";
// sectorGeometry.ts, not sectorConnector.ts — the latter also imports
// "react" for its hooks, which this e2e project's own node_modules doesn't
// have (CI only runs `npm ci` in e2e/, never in frontend/ — see
// .github/workflows). sectorGeometry.ts has zero runtime dependencies of
// its own, by design, for exactly this reason.
import { segmentCrossesCircle } from "../../frontend/src/lib/sectorGeometry";
import { createTransaction, getCategoryId, getDefaultAccountId } from "./helpers";

// See docs/tasks/donut-chart-interaction.md: hovering a donut sector
// highlights its list row (and vice versa) with a synchronized, reversible
// highlight; keyboard focus and a phone tap give the same pairing; a click
// pins it until clicked again or Escape. Covers the three
// genuinely-donut-next-to-list surfaces reviewed for this task —
// SpendingByCategoryCard (dashboard), CryptoAllocationBody and
// CryptoNetworkAllocationBody (crypto page) — plus the SpendingByCategoryCard
// stale-breakdown fix. AssetAllocationCard (net worth) is a segmented bar,
// not a donut, and CryptoRiskAllocationBody/CryptoStatsRow have no chart at
// all — none of the three have a sector to synchronize with, so none were
// touched (see the PR description for the full reviewed/scope list).
//
// See docs/tasks/dashboard-donut-colors-routing.md for a later, dashboard-
// only change on top of the above: SpendingByCategoryCard now fills
// colliding categories with a solid ramp color instead of a hatched
// pattern (colorPatterns.ts, removed), and its connector is a routed
// polyline (useDonutConnectorPath) instead of one straight line —
// CryptoAllocationBody/CryptoNetworkAllocationBody keep the original
// pattern-free-by-construction ramp and the straight `useSectorConnectorLine`
// exactly as before, unaffected by either change.

const BASE_URL = process.env.AURUM_E2E_BASE_URL ?? "http://localhost:3100";

/** The connector line's chart-side endpoint (x2/y2, see sectorConnector.ts),
 * converted to page coordinates — read straight off the actual rendered
 * <line>, not recomputed, so a test comparing it against a sector's own
 * bounding box is checking what was really drawn. The wrapping <svg> is the
 * absolutely-positioned overlay sized to `containerRef` (see
 * CryptoAllocationBody.tsx/CryptoNetworkAllocationBody.tsx — the dashboard's
 * own connector is a routed <polyline>, see connectorPolylinePoints below)
 * — its own bounding box in page space is exactly the offset the line's
 * local coordinates are relative to. */
async function connectorLineEndpoint(card: Locator): Promise<{ x: number; y: number }> {
  const svg = card.locator("svg.absolute.inset-0");
  // Sequential, not Promise.all — reading the box and the line's own
  // attributes concurrently occasionally raced and returned a transient/
  // incomplete value for one of them.
  const svgBox = await svg.boundingBox();
  if (!svgBox) throw new Error("connector line <svg> not found");
  const point = await svg.locator("line").evaluate((el) => ({ x2: Number(el.getAttribute("x2")), y2: Number(el.getAttribute("y2")) }));
  return { x: svgBox.x + point.x2, y: svgBox.y + point.y2 };
}

/** The dashboard's own routed connector — every waypoint of the actual
 * rendered <polyline>, converted to page coordinates (same offset
 * convention as connectorLineEndpoint above). */
async function connectorPolylinePoints(card: Locator): Promise<{ x: number; y: number }[]> {
  const svg = card.locator("svg.absolute.inset-0");
  const svgBox = await svg.boundingBox();
  if (!svgBox) throw new Error("connector polyline <svg> not found");
  const raw = await svg.locator("polyline").getAttribute("points");
  if (!raw) throw new Error("connector <polyline> has no points");
  return raw
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x: svgBox.x + x, y: svgBox.y + y };
    });
}

async function expectPointInsideBox(point: { x: number; y: number }, box: Locator, slackPx = 4) {
  const rect = await box.boundingBox();
  expect(rect).not.toBeNull();
  expect(point.x).toBeGreaterThanOrEqual(rect!.x - slackPx);
  expect(point.x).toBeLessThanOrEqual(rect!.x + rect!.width + slackPx);
  expect(point.y).toBeGreaterThanOrEqual(rect!.y - slackPx);
  expect(point.y).toBeLessThanOrEqual(rect!.y + rect!.height + slackPx);
}

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
  const sectorA = chart.getByRole("button", { name: /^Donut A,/ });
  const sectorB = chart.getByRole("button", { name: /^Donut B,/ });

  // Before any interaction at all: two categories sharing the exact same
  // color must already render as visually distinguishable sectors — relying
  // on the synchronized highlight alone wouldn't help a sighted user who
  // hasn't hovered anything yet. Solid ramp colors now, not a hatched
  // pattern (see resolveDonutColors in @/lib/dashboardDonutColors).
  const [fillA, fillB] = await Promise.all([sectorA.getAttribute("fill"), sectorB.getAttribute("fill")]);
  expect(fillA).toBe(sameColor); // the color's first occurrence stays plain
  expect(fillB).toMatch(/^var\(--series-\d\)$/); // the collision borrows a solid ramp color, no hatching
  expect(fillA).not.toBe(fillB);
  // The row's own marker matches its sector exactly, including the
  // collision — same map, not a second independent notion of the color.
  const rowBIcon = rowB.locator("svg");
  const probe = await page.evaluateHandle((color) => {
    const div = document.createElement("div");
    div.style.color = color;
    return div.style.color;
  }, fillB!);
  expect(await rowBIcon.evaluate((el) => (el as HTMLElement).style.color)).toBe(await probe.jsonValue());

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
  await expect(rowB).not.toHaveClass(/bg-surface-2/); // togglePin clears the hover a click itself triggers, not just the pin
  await page.mouse.move(0, 0);
  await expect(rowB).not.toHaveClass(/bg-surface-2/);

  // Escape un-pins from anywhere, not just by clicking the same row again.
  await rowA.click();
  await expect(rowA).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(rowA).toHaveAttribute("aria-pressed", "false");
  await page.mouse.move(0, 0);
  await expect(rowA).not.toHaveClass(/bg-surface-2/);
});

test("five same-colored dashboard categories get five genuinely distinct solid fills, and each row matches its own sector", async ({ page, request }) => {
  // Isolated via the same export/wipe-transactions/restore dance as "a
  // single expense category..." below — other specs in this same run (and
  // earlier tests in this file) already have their own categories with
  // real spend; sharing that pool here would either pull in an unrelated
  // color collision or, combined with five *more* categories, tip the
  // dashboard's own MAX_CHART_SLICES=8 "Other" folding for every test that
  // runs after this one. Wiping transactions (categories are kept, just
  // temporarily spend-free so none show up) and restoring afterward keeps
  // this test's five categories from outliving it.
  const snapshot = await (await request.get("/api/backup/export")).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]: [string, unknown]) =>
    [key, Array.isArray(value) && !["accounts", "categories"].includes(key) ? [] : value]));
  try {
    expect((await request.post("/api/backup/import", { data: empty })).ok()).toBeTruthy();
    const accountId = await getDefaultAccountId(request);
    const color = "#2a78d6";
    // Five is the minimum the review asked for, well under
    // MAX_CHART_SLICES=8 (dashboard_service.py) — the most this donut can
    // ever actually show before folding into "Other".
    const names = ["Palette One", "Palette Two", "Palette Three", "Palette Four", "Palette Five"];
    const amounts = ["50.00", "40.00", "30.00", "20.00", "10.00"];
    for (let i = 0; i < names.length; i++) {
      const category = await (await request.post("/api/categories", { data: { name: names[i], kind: "expense", color } })).json();
      await createTransaction(request, { account_id: accountId, category_id: category.id, type: "expense", amount: amounts[i], description: `palette-${i}`, date: "2024-06-01" });
    }

    await page.goto("/");
    const card = page.locator("div.rounded-xl", { has: page.getByText("Расходы по категориям", { exact: true }) });
    const list = card.locator("ul");
    const chart = card.locator(".recharts-wrapper");

    // The color's first occurrence stays plain, and its sector is the only
    // one still showing the raw color.
    const firstSector = chart.getByRole("button", { name: new RegExp(`^${names[0]},`) });
    expect(await firstSector.getAttribute("fill")).toBe(color);

    // Every occurrence after the first borrows a solid ramp color — matched
    // exactly between the row's own icon marker and its sector (so the
    // pairing is legible without hovering anything), and genuinely distinct
    // from every other collision's color, not just a different pattern id.
    const collisionFills: string[] = [];
    for (const name of names.slice(1)) {
      const row = list.getByRole("button", { name: new RegExp(`^${name}\\b`) });
      const sector = chart.getByRole("button", { name: new RegExp(`^${name},`) });
      const rowIconColor = await row.locator("svg").evaluate((el) => (el as HTMLElement).style.color);
      const sectorFill = await sector.getAttribute("fill");
      expect(sectorFill).toMatch(/^var\(--series-\d\)$/);
      const normalizedSectorFill = await page.evaluate((color) => {
        const div = document.createElement("div");
        div.style.color = color;
        return div.style.color;
      }, sectorFill!);
      expect(rowIconColor).toBe(normalizedSectorFill);
      collisionFills.push(sectorFill!);
    }
    expect(new Set(collisionFills).size).toBe(collisionFills.length);
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test("the dashboard's routed connector reaches the real arc on both the near and far half, never crossing the donut itself, with an absent line and no overflow at 375px", async ({ page, request }) => {
  // Isolated the same way as "five same-colored..." above — this test's own
  // three categories have to be the *only* spending on the dashboard, or
  // another spec's leftover categories/transactions in this shared-DB run
  // shift the proportions (and therefore the angles) enough that "Far"
  // might not land on the far side any more, silently making the detour
  // assertion below meaningless instead of failing loudly.
  const snapshot = await (await request.get("/api/backup/export")).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]: [string, unknown]) =>
    [key, Array.isArray(value) && !["accounts", "categories"].includes(key) ? [] : value]));
  expect((await request.post("/api/backup/import", { data: empty })).ok()).toBeTruthy();
  try {
    const accountId = await getDefaultAccountId(request);
    // Three unequal shares (not just two) so one of them lands on the *far*
    // half of the donut (away from the list, where the routed line has to
    // detour around the ring rather than cut a near-straight shot) and
    // another lands on the near half — see docs/tasks/
    // dashboard-donut-colors-routing.md's "особенно дальняя от списка
    // половина" acceptance point.
    const far = (await (await request.post("/api/categories", { data: { name: "Connector Far", kind: "expense", color: "#2a78d6" } })).json());
    const near = (await (await request.post("/api/categories", { data: { name: "Connector Near", kind: "expense", color: "#eb6834" } })).json());
    const rest = (await (await request.post("/api/categories", { data: { name: "Connector Rest", kind: "expense", color: "#1baf7a" } })).json());
    await createTransaction(request, { account_id: accountId, category_id: far.id, type: "expense", amount: "45.00", description: "connector-far", date: "2024-06-01" });
    await createTransaction(request, { account_id: accountId, category_id: near.id, type: "expense", amount: "10.00", description: "connector-near", date: "2024-06-01" });
    await createTransaction(request, { account_id: accountId, category_id: rest.id, type: "expense", amount: "45.00", description: "connector-rest", date: "2024-06-01" });

    await page.goto("/");
    const card = page.locator("div.rounded-xl", { has: page.getByText("Расходы по категориям", { exact: true }) });
    const chartWrapper = card.locator(".recharts-wrapper");
    // Three categories is a genuinely short list — comfortably shorter than
    // the donut itself at this viewport, exactly the shape that clips a
    // detour corner (which pokes a few pixels above/below the chart's own
    // box) unless the connector's own <svg> explicitly opts out of the
    // clipping SVG applies to its content by default.
    async function checkRoutedConnector(name: string) {
      const row = card.locator("ul").getByRole("button", { name: new RegExp(`^${name}\\b`) });
      const sector = chartWrapper.getByRole("button", { name: new RegExp(`^${name},`) });
      await row.hover();

      const polyline = card.locator("svg polyline");
      await expect(polyline).toBeVisible();
      await expect(card.locator("svg.absolute.inset-0")).toHaveCSS("overflow", "visible");

      const [points, rowBox, chartBox, containerBox] = await Promise.all([
        connectorPolylinePoints(card),
        row.boundingBox(),
        chartWrapper.boundingBox(),
        card.locator("div.relative").first().boundingBox(),
      ]);
      expect(rowBox).not.toBeNull();
      expect(chartBox).not.toBeNull();
      expect(containerBox).not.toBeNull();

      // Equal first horizontal run — same length regardless of which row or
      // which side of the donut it points to.
      expect(points[0].y).toBeCloseTo(rowBox!.y + rowBox!.height / 2, 0);
      expect(points[0].x - points[1].x).toBeCloseTo(16, 0);

      // The endpoint lands inside the specific active sector's own rendered
      // path — the real arc, not just anywhere in the chart's outer square.
      await expectPointInsideBox(points[points.length - 1], sector);

      // Every segment of the *actual rendered* route — read from real layout,
      // not synthetic test coordinates — stays clear of the donut itself.
      // margin=5 mirrors CHART_MARGIN_PX in sectorGeometry.ts (Recharts' own
      // default chart margin, unrelated to this task and unchanged by it).
      const margin = 5;
      const center = { x: chartBox!.x + chartBox!.width / 2, y: chartBox!.y + chartBox!.height / 2 };
      const outerRadius = Math.min(chartBox!.width - 2 * margin, chartBox!.height - 2 * margin) / 2;
      for (let i = 0; i < points.length - 1; i++) {
        expect(segmentCrossesCircle(points[i], points[i + 1], center, outerRadius)).toBe(false);
      }

      // The detour route (far side) actually pokes above/below this short
      // list's own container box — the exact shape that clips without
      // overflow-visible on the connector's <svg> above. Confirms this test
      // is exercising the real bug, not just a case where clipping was never
      // in play to begin with.
      if (points.length > 4) {
        const detouredAboveOrBelow = points.some((point) => point.y < containerBox!.y - 1 || point.y > containerBox!.y + containerBox!.height + 1);
        expect(detouredAboveOrBelow).toBe(true);
      }

      await page.mouse.move(0, 0);
    }

    await checkRoutedConnector("Connector Far");
    await checkRoutedConnector("Connector Near");

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    await page.setViewportSize({ width: 375, height: 900 });
    await card.locator("ul").getByRole("button", { name: /Connector Far/ }).hover();
    await expect(card.locator("svg polyline")).toHaveCount(0); // stacked layout — sync highlight only, no line
    const narrowOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(narrowOverflow.scrollWidth).toBeLessThanOrEqual(narrowOverflow.clientWidth);
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test("a real touch tap pins/unpins a row without leaving artificial hover or dimming behind", async ({ browser, request }) => {
  const accountId = await getDefaultAccountId(request);
  const catA = (await (await request.post("/api/categories", { data: { name: "Tap A", kind: "expense", color: "#2a78d6" } })).json());
  const catB = (await (await request.post("/api/categories", { data: { name: "Tap B", kind: "expense", color: "#eb6834" } })).json());
  await createTransaction(request, { account_id: accountId, category_id: catA.id, type: "expense", amount: "40.00", description: "tap-a", date: "2024-06-01" });
  await createTransaction(request, { account_id: accountId, category_id: catB.id, type: "expense", amount: "20.00", description: "tap-b", date: "2024-06-01" });

  // A manually-created context does *not* inherit playwright.config.ts's own
  // `use` block (baseURL/storageState for the no-auth-modal flag) — both
  // have to be repeated explicitly here. `hasTouch: true` is what makes
  // `.tap()` dispatch real touch events (touchstart/touchend), rather than
  // standing in for a click.
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 375, height: 900 },
    hasTouch: true,
    storageState: { cookies: [], origins: [{ origin: new URL(BASE_URL).origin, localStorage: [{ name: "aurum:noAuthAcknowledged", value: "1" }] }] },
  });
  try {
    const page = await context.newPage();
    await page.route("**/api/fx-rates/nbp/latest", (route) => route.fulfill({ json: { saved: 0, absent_currencies: [] } }));
    await page.goto("/");

    const card = page.locator("div.rounded-xl", { has: page.getByText("Расходы по категориям", { exact: true }) });
    const rowA = card.locator("ul").getByRole("button", { name: /Tap A/ });
    const rowB = card.locator("ul").getByRole("button", { name: /Tap B/ });

    await rowA.tap();
    await expect(rowA).toHaveAttribute("aria-pressed", "true");
    await expect(rowA).toHaveClass(/bg-surface-2/);
    await expect(rowB).toHaveClass(/opacity-40/);

    // A second tap on the same row must fully un-pin — a touch device has no
    // real hover to begin with, so nothing should stay "previewed" once the
    // tap gesture itself is over.
    await rowA.tap();
    await expect(rowA).toHaveAttribute("aria-pressed", "false");
    await expect(rowA).not.toHaveClass(/bg-surface-2/);
    await expect(rowB).not.toHaveClass(/opacity-40/);
  } finally {
    await context.close();
  }
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

test("crypto allocation donut: hover/keyboard/Enter/Space/Escape sync the same way, and masked amounts stay masked in the accessible label", async ({ page }) => {
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
  // The accessible control for each row is the <button> inside its first
  // cell (see CryptoAllocationBody.tsx) — the <tr> itself only carries
  // "row" semantics (hover-only, for a comfortably large mouse target), not
  // aria-pressed. Scoped to this one card's own table — the page also has
  // an unrelated full holdings table further down sharing "BTC"/"ETH" text.
  const btcRow = overviewCard.locator("table tbody").getByRole("button", { name: /Bitcoin \(BTC\)/ });
  const ethRow = overviewCard.locator("table tbody").getByRole("button", { name: /Ethereum \(ETH\)/ });
  // The row's own highlight class lives on its containing <tr>, one level up
  // from the accessible button — walk up via XPath rather than a `.filter({
  // has })`, which resolves the "row"-vs-"button" containment ambiguously.
  const btcTr = btcRow.locator("xpath=ancestor::tr[1]");
  const ethTr = ethRow.locator("xpath=ancestor::tr[1]");
  // The table row's own button now shares its accessible name with the
  // sector (both say "Bitcoin (BTC), ..."), so this has to be scoped to the
  // chart's own wrapper the same way the dashboard's row/sector locators are.
  const btcSector = overviewCard.locator(".recharts-wrapper").getByRole("button", { name: /^Bitcoin \(BTC\),/ });

  await btcRow.hover();
  await expect(btcTr).toHaveClass(/bg-surface-2/);
  await expect(ethTr).toHaveClass(/opacity-40/);
  await page.mouse.move(0, 0);

  await btcSector.focus();
  await expect(btcTr).toHaveClass(/bg-surface-2/);
  await page.keyboard.press("Escape");

  // Enter and Space both pin — a real toggle button responds to either —
  // and Escape un-pins again from keyboard focus, without ever clicking.
  await btcRow.focus();
  await page.keyboard.press("Enter");
  await expect(btcRow).toHaveAttribute("aria-pressed", "true");
  await expect(btcTr).toHaveClass(/bg-surface-2/);
  await page.keyboard.press("Enter");
  await expect(btcRow).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Space");
  await expect(btcRow).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(btcRow).toHaveAttribute("aria-pressed", "false");
  await expect(btcTr).not.toHaveClass(/bg-surface-2/);

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

test("crypto networks donut: hover sync and the connector line land on the real arc, same as the coin donut", async ({ page }) => {
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
  const bitcoinRow = overviewCard.locator("table tbody").getByRole("button", { name: /bitcoin/i }).first();
  const bitcoinTr = bitcoinRow.locator("xpath=ancestor::tr[1]");
  const bitcoinSector = overviewCard.locator(".recharts-wrapper").getByRole("button", { name: /^bitcoin,/i });
  await bitcoinRow.hover();
  await expect(bitcoinTr).toHaveClass(/bg-surface-2/);

  // Scoped to this card — the sidebar nav has its own unrelated <svg><line>
  // icons (e.g. the ROI link) elsewhere on the page.
  const endpoint = await connectorLineEndpoint(overviewCard);
  await expectPointInsideBox(endpoint, bitcoinSector);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});
