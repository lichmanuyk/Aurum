import { afterEach, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { SpendingByCategoryCard } from "./SpendingByCategoryCard";
import { resolveDonutColors } from "@/lib/dashboardDonutColors";
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

it("does not resurrect a cleared pin when the same category comes back in a later items list", () => {
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

  // Category A drops out entirely (e.g. a period switch with no spend in
  // it that period)...
  flushSync(() => root.render(<SpendingByCategoryCard items={[makeItem({ category_id: 2, name: "B", amount: "30", children: [] })]} />));
  // ...then comes back. The pin must have been genuinely cleared when it
  // disappeared, not merely hidden for that one render — otherwise it
  // silently reactivates here on a row the user never clicked this time.
  flushSync(() => root.render(<SpendingByCategoryCard items={items} />));

  const revivedRowA = container.querySelectorAll("ul button")[0] as HTMLButtonElement;
  expect(revivedRowA.getAttribute("aria-pressed")).toBe("false");
  expect(revivedRowA.className).not.toContain("bg-surface-2");
});

it("a row past the first same-colored occurrence shows the same resolved solid color the sector will use — no hatching, and the icon marker matches", () => {
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
  // Exactly one <svg> per row — the category icon itself. No extra pattern
  // swatch alongside it: a solid marker is the whole point now.
  expect(rowA.querySelectorAll("svg")).toHaveLength(1);
  expect(rowB.querySelectorAll("svg")).toHaveLength(1);

  // Cross-checks against the exact same shared function the donut's own
  // sectors use — not a second, independently-duplicated notion of "what
  // color this row should show".
  const resolved = resolveDonutColors(items.map((item) => ({ key: String(item.category_id), color: item.color })));
  expect(resolved.get("1")).toBe("#2a78d6"); // first occurrence keeps the real color
  expect(resolved.get("2")).toMatch(/^var\(--series-\d\)$/); // the collision borrows a solid ramp color

  const iconA = rowA.querySelector("svg") as SVGElement | null;
  const iconB = rowB.querySelector("svg") as SVGElement | null;
  // jsdom normalizes a literal hex string to rgb(...) once it's parsed as a
  // real CSS color value, but leaves an unresolved var(--x) reference as-is
  // — compare A through the same normalization instead of the raw hex.
  const probe = document.createElement("div");
  probe.style.color = resolved.get("1")!;
  expect(iconA?.style.color).toBe(probe.style.color);
  expect(iconB?.style.color).toBe(resolved.get("2"));
});
