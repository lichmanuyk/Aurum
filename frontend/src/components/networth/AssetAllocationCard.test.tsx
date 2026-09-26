import { afterEach, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { AssetAllocationCard } from "./AssetAllocationCard";
import type { NetWorthBreakdownItem } from "@/types";

function makeItem(overrides: Partial<NetWorthBreakdownItem> = {}): NetWorthBreakdownItem {
  return { key: "cash", name: "Cash", color: "#2a78d6", icon: "wallet", amount: "100", percent: 100, ...overrides };
}

let container: HTMLDivElement;
let root: Root;

function render(breakdown: NetWorthBreakdownItem[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<AssetAllocationCard breakdown={breakdown} isLoading={false} />));
}

function segments(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[role="button"]')).filter((el) => el.tagName !== "BUTTON") as HTMLElement[];
}

function rowButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("ul button"));
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

it("renders the bar segments, legend and detail rows in the same descending-by-value order, not the API's own order", () => {
  render([
    makeItem({ key: "cash", amount: "10", percent: 10 }),
    makeItem({ key: "investments", amount: "70", percent: 70 }),
    makeItem({ key: "crypto", amount: "20", percent: 20 }),
  ]);

  const segmentOrder = segments().map((el) => el.getAttribute("aria-label"));
  const rowOrder = rowButtons().map((el) => el.textContent);
  // Backend order is cash, investments, crypto — display order must be
  // investments (70) > crypto (20) > cash (10) everywhere.
  expect(segmentOrder[0]).toMatch(/^Инвестиции/);
  expect(segmentOrder[1]).toMatch(/^Криптовалюта/);
  expect(segmentOrder[2]).toMatch(/^Счета/);
  expect(rowOrder[0]).toContain("Инвестиции");
  expect(rowOrder[1]).toContain("Криптовалюта");
  expect(rowOrder[2]).toContain("Счета");
});

it("focusing a row highlights it and its segment, dims the others, and reverts on blur", () => {
  render([makeItem({ key: "cash", amount: "70", percent: 70 }), makeItem({ key: "investments", amount: "30", percent: 30 })]);

  const [rowCash] = rowButtons(); // sorted descending — cash (70) first
  const segCash = segments()[0];
  const rowInvestments = rowButtons()[1];

  flushSync(() => rowCash.focus());
  expect(rowCash.className).toContain("bg-surface-2");
  expect(segCash.style.opacity).toBe("1"); // active segment stays fully opaque
  expect(rowInvestments.className).toContain("opacity-40");

  flushSync(() => rowCash.blur());
  expect(rowCash.className).not.toContain("bg-surface-2");
  expect(rowInvestments.className).not.toContain("opacity-40");
});

it("interacting with the segment highlights the row the other way around", () => {
  render([makeItem({ key: "cash", amount: "70", percent: 70 }), makeItem({ key: "investments", amount: "30", percent: 30 })]);

  const segCash = segments()[0];
  const rowCash = rowButtons()[0];

  flushSync(() => segCash.focus());
  expect(rowCash.className).toContain("bg-surface-2");
});

it("a click pins the highlight and Escape un-pins it", () => {
  render([makeItem({ key: "cash", amount: "70", percent: 70 }), makeItem({ key: "investments", amount: "30", percent: 30 })]);

  const rowCash = rowButtons()[0];
  flushSync(() => rowCash.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(rowCash.getAttribute("aria-pressed")).toBe("true");

  flushSync(() => rowCash.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(rowCash.getAttribute("aria-pressed")).toBe("false");
});

it("clears the pin instead of erroring when the pinned class disappears from a refreshed breakdown", () => {
  render([makeItem({ key: "cash", amount: "70", percent: 70 }), makeItem({ key: "investments", amount: "30", percent: 30 })]);

  const rowCash = rowButtons()[0];
  flushSync(() => rowCash.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(rowCash.getAttribute("aria-pressed")).toBe("true");

  // A currency/data refresh that drops "cash" entirely (e.g. every cash
  // account emptied out) — must not crash, and must not keep "cash" pinned
  // against a row that no longer exists.
  flushSync(() => root.render(<AssetAllocationCard breakdown={[makeItem({ key: "investments", amount: "30", percent: 100 })]} isLoading={false} />));

  expect(rowButtons()).toHaveLength(1);
  expect(rowButtons()[0].getAttribute("aria-pressed")).toBe("false");
});
