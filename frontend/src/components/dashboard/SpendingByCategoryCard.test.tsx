import { afterEach, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { SpendingByCategoryCard } from "./SpendingByCategoryCard";
import { buildColorPatterns } from "@/lib/colorPatterns";
import { setCurrency } from "@/lib/i18n";
import type { CategoryBreakdownItem } from "@/types";

/** `amount` drives both the row's own total and its (single, direct-spend)
 * child, so a test can tell "old amount, new currency" apart from "new
 * amount, new currency" by substring alone — same fixture shape as
 * CategoryRankingCard.test.tsx's own equivalent. */
function makeItem(overrides: Partial<CategoryBreakdownItem> = {}): CategoryBreakdownItem {
  const amount = overrides.amount ?? "100";
  return {
    category_id: 1, name: "Groceries", color: "#2a78d6", icon: null,
    amount, percent: 100,
    children: [{ category_id: 1, name: "Groceries", color: "#2a78d6", icon: null, amount }],
    ...overrides,
  };
}

function openBreakdown(container: HTMLDivElement) {
  const expandButton = container.querySelector<HTMLButtonElement>("button[aria-label]");
  flushSync(() => expandButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  setCurrency("USD");
});

it("shows the current item's amount under the current currency, never a stale amount under a new label", () => {
  setCurrency("USD");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  flushSync(() => root.render(<SpendingByCategoryCard items={[makeItem({ amount: "123" })]} />));
  openBreakdown(container);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).toContain("123");

  // Currency and amounts change together, same as switching the display
  // currency triggers a refetch with newly converted totals.
  setCurrency("EUR");
  flushSync(() => root.render(<SpendingByCategoryCard items={[makeItem({ amount: "456" })]} />));

  // The still-open modal must reflect the new item, not the one open when
  // it was clicked — "123" (the old amount) must never appear relabeled
  // under the new currency.
  expect(container.textContent).not.toContain("123");
  expect(container.textContent).toContain("456");
});

it("closes the breakdown instead of showing stale data once its category is no longer in items", () => {
  setCurrency("USD");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  flushSync(() => root.render(<SpendingByCategoryCard items={[makeItem({ amount: "100" })]} />));
  openBreakdown(container);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();

  // Mid-refetch (or the category dropped out of the period entirely) —
  // items no longer contains category_id 1.
  flushSync(() => root.render(<SpendingByCategoryCard items={[]} />));

  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("focusing (same code path as hovering) a row highlights it and dims the other row, and reverts on blur", () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const items = [
    makeItem({ category_id: 1, name: "A", amount: "70", children: [] }),
    makeItem({ category_id: 2, name: "B", amount: "30", children: [] }),
  ];
  flushSync(() => root.render(<SpendingByCategoryCard items={items} />));

  const rowButtons = Array.from(container.querySelectorAll("ul button")) as HTMLButtonElement[];
  const [rowA, rowB] = rowButtons;
  // Hover and keyboard focus share the exact same enter/leave handlers in
  // this component (see chartSelection.ts), so exercising it through
  // focus — a native DOM method with no event-synthesis ambiguity — is
  // exactly as meaningful here as hover; real mouse hover itself is
  // covered end to end in a real browser by donut-chart-interaction.spec.ts.
  flushSync(() => rowA.focus());
  expect(rowA.className).toContain("bg-surface-2");
  expect(rowB.className).toContain("opacity-40");

  flushSync(() => rowA.blur());
  expect(rowA.className).not.toContain("bg-surface-2");
  expect(rowB.className).not.toContain("opacity-40");
});

it("a click pins the highlight and Escape un-pins it", () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const items = [
    makeItem({ category_id: 1, name: "A", amount: "70", children: [] }),
    makeItem({ category_id: 2, name: "B", amount: "30", children: [] }),
  ];
  flushSync(() => root.render(<SpendingByCategoryCard items={items} />));

  const rowA = container.querySelectorAll("ul button")[0] as HTMLButtonElement;
  flushSync(() => rowA.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(rowA.getAttribute("aria-pressed")).toBe("true");

  flushSync(() => rowA.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(rowA.getAttribute("aria-pressed")).toBe("false");
});

it("a row past the first same-colored occurrence shows the same pattern swatch buildColorPatterns computes for it, and the first shows none", () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // makeItem's default color (#2a78d6) is shared by both, unless overridden.
  const items = [
    makeItem({ category_id: 1, name: "A", amount: "70", children: [] }),
    makeItem({ category_id: 2, name: "B", amount: "30", children: [] }),
  ];
  flushSync(() => root.render(<SpendingByCategoryCard items={items} />));

  const rows = Array.from(container.querySelectorAll("ul > li"));
  const [rowA, rowB] = rows;
  expect(rowA.querySelector("svg rect")).toBeNull(); // color's first occurrence needs no extra marker
  const swatch = rowB.querySelector("svg rect");
  expect(swatch).not.toBeNull();

  // Cross-checks against the exact same shared function the donut's own
  // sectors use — not a second, independently-duplicated notion of "what
  // pattern this row should show".
  const expectedFill = buildColorPatterns(
    "spending-donut",
    items.map((item) => ({ key: String(item.category_id), color: item.color }))
  ).fillFor(String(items[1].category_id));
  expect(swatch!.getAttribute("fill")).toBe(expectedFill);
});

// The "two same-colored categories get different sector fills at rest"
// requirement (see buildColorPatterns in @/lib/colorPatterns, covered by its
// own colorPatterns.test.ts) is verified end to end in a real browser
// instead of here — jsdom's ResponsiveContainer reports a 0×0 box, so
// Recharts never actually renders any <Pie> sectors in this environment to
// begin with (see donut-chart-interaction.spec.ts's first test).
