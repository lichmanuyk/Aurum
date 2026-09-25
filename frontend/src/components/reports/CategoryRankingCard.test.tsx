import { afterEach, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { CategoryRankingCard } from "./CategoryRankingCard";
import { setCurrency } from "@/lib/i18n";
import type { CategoryRankingItem } from "@/types";

/** `amount` drives both the row's own total and its (single, direct-spend)
 * child, so a test can tell "old amount, new currency" apart from "new
 * amount, new currency" by substring alone — no shared "100" appearing in
 * both the before and after fixture to muddy the assertion. */
function makeItem(overrides: Partial<CategoryRankingItem> = {}): CategoryRankingItem {
  const amount = overrides.amount ?? "100";
  return {
    category_id: 1, name: "Groceries", color: "#2a78d6", icon: null,
    amount, percent: 100, transaction_count: 1,
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

  flushSync(() => root.render(
    <CategoryRankingCard items={[makeItem({ amount: "123" })]} isLoading={false} selectedCategoryId={null} onSelectCategory={() => {}} />
  ));
  openBreakdown(container);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).toContain("123");

  // Currency and amounts change together, same as switching the display
  // currency triggers a refetch with newly converted totals. (A single
  // direct-spend child always reads 100% of its own parent's total — that's
  // unrelated to either amount, so it's not what the assertions below are
  // about.)
  setCurrency("EUR");
  flushSync(() => root.render(
    <CategoryRankingCard items={[makeItem({ amount: "456" })]} isLoading={false} selectedCategoryId={null} onSelectCategory={() => {}} />
  ));

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

  flushSync(() => root.render(
    <CategoryRankingCard items={[makeItem({ amount: "100" })]} isLoading={false} selectedCategoryId={null} onSelectCategory={() => {}} />
  ));
  openBreakdown(container);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();

  // Mid-refetch (or the category dropped out of the ranking entirely) —
  // items no longer contains category_id 1.
  flushSync(() => root.render(
    <CategoryRankingCard items={[]} isLoading={false} selectedCategoryId={null} onSelectCategory={() => {}} />
  ));

  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("renders rows as links to Reports with the category and period, not a local selector, when linkTo is given", () => {
  setCurrency("USD");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onSelectCategory = () => { throw new Error("should not be called in linkTo mode"); };

  flushSync(() => root.render(
    <MemoryRouter>
      <CategoryRankingCard
        items={[makeItem({ category_id: 7 })]}
        isLoading={false}
        onSelectCategory={onSelectCategory}
        linkTo={(categoryId) => `/reports?category_id=${categoryId}&range=this_year`}
      />
    </MemoryRouter>
  ));

  const link = container.querySelector<HTMLAnchorElement>("a[href]");
  expect(link).not.toBeNull();
  expect(link!.getAttribute("href")).toBe("/reports?category_id=7&range=this_year");
  // Clicking navigates via the anchor's own href — it must not also fall
  // through to the same-page selector callback.
  flushSync(() => link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
});
