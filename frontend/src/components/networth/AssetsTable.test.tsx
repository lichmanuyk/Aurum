import { afterEach, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { AssetsTable } from "./AssetsTable";
import type { Asset } from "@/types";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 1,
    name: "Synthetic asset",
    asset_class: "other",
    currency: "USD",
    notes: null,
    capital_role: "neutral",
    monthly_cash_flow: null,
    risk_level: "medium",
    current_value: "100",
    as_of_date: "2024-06-01",
    capital_value: "100",
    capital_currency: "USD",
    capital_value_error: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function renderTable(items: Asset[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<AssetsTable items={items} onEdit={() => {}} onDelete={() => {}} onMovement={() => {}} />));
}

function rowNames(): string[] {
  return Array.from(container.querySelectorAll("li")).map(
    (li) => li.querySelector(".text-sm.font-medium.text-text-primary")?.textContent ?? ""
  );
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

it("orders by each asset's capital equivalent, not its native amount, when native numbers would rank it backwards", () => {
  // Native amounts (10 vs 20) alone would rank "Big native" first, but its
  // real equivalent (5) is the smaller of the two.
  renderTable([
    makeAsset({ id: 1, name: "Big native", current_value: "20", capital_value: "5" }),
    makeAsset({ id: 2, name: "Small native", current_value: "10", capital_value: "11" }),
  ]);

  expect(rowNames()).toEqual(["Small native", "Big native"]);
});

it("breaks a tie in capital value by name, then by id", () => {
  renderTable([
    makeAsset({ id: 2, name: "Zed", capital_value: "50", current_value: "999" }),
    // Both "Alpha" rows also tie on name — current_value tags which is
    // which, since nothing else about them differs.
    makeAsset({ id: 3, name: "Alpha", capital_value: "50", current_value: "333" }),
    makeAsset({ id: 1, name: "Alpha", capital_value: "50", current_value: "111" }),
  ]);

  expect(rowNames()).toEqual(["Alpha", "Alpha", "Zed"]);
  const amounts = Array.from(container.querySelectorAll("li")).map((li) => li.textContent ?? "");
  expect(amounts[0]).toContain("111"); // id 1 before id 3, both named "Alpha"
  expect(amounts[1]).toContain("333");
});

it("treats a real recorded zero as a genuine, sortable value — not missing", () => {
  renderTable([
    makeAsset({ id: 1, name: "Has value", capital_value: "5" }),
    makeAsset({ id: 2, name: "Zeroed out", capital_value: "0", capital_value_error: null }),
  ]);

  expect(rowNames()).toEqual(["Has value", "Zeroed out"]);
  expect(container.textContent).not.toContain("нет оценки");
  expect(container.textContent).not.toContain("нет курса");
});

it("keeps an asset with no valuation yet visible, sorted after every valued asset, with an explicit label", () => {
  renderTable([
    makeAsset({ id: 1, name: "Valued", capital_value: "1" }),
    makeAsset({ id: 2, name: "Not valued yet", capital_value: null, capital_value_error: "no_valuation" }),
  ]);

  expect(rowNames()).toEqual(["Valued", "Not valued yet"]);
  expect(container.textContent).toContain("нет оценки");
});

it("shows a dash instead of a monetary 0 for a never-valued asset, but keeps a real recorded zero and a known native amount with a missing FX rate as real figures", () => {
  renderTable([
    makeAsset({ id: 1, name: "Not valued yet", current_value: "0", capital_value: null, capital_value_error: "no_valuation" }),
    makeAsset({ id: 2, name: "Really zero", current_value: "0", capital_value: "0", capital_value_error: null }),
    makeAsset({ id: 3, name: "No FX rate", current_value: "10", currency: "GBP", capital_value: null, capital_value_error: "fx_rate_missing" }),
  ]);

  const rows = Array.from(container.querySelectorAll("li"));
  const amountOf = (name: string) =>
    rows.find((li) => li.textContent?.includes(name))?.querySelector(".text-sm.font-medium.tabular-nums.text-text-primary")?.textContent;

  expect(amountOf("Not valued yet")).toBe("—");
  // A genuine zero valuation still reads as a real amount, not a dash.
  expect(amountOf("Really zero")).not.toBe("—");
  expect(amountOf("Really zero")).toMatch(/0/);
  // The native amount is known even without a capital-currency equivalent —
  // only the *equivalent* is missing, so the native figure stays a number.
  expect(amountOf("No FX rate")).not.toBe("—");
  expect(amountOf("No FX rate")).toMatch(/10/);
});

it("keeps an asset with a missing FX rate visible, sorted after every valued asset, with an explicit label distinct from 'no valuation'", () => {
  renderTable([
    makeAsset({ id: 1, name: "Valued", capital_value: "1" }),
    makeAsset({ id: 2, name: "No rate", capital_value: null, capital_value_error: "fx_rate_missing" }),
  ]);

  expect(rowNames()).toEqual(["Valued", "No rate"]);
  expect(container.textContent).toContain("нет курса");
  expect(container.textContent).not.toContain("нет оценки");
});

it("shows the capital-currency equivalent alongside the native amount when they differ, and omits it when they match", () => {
  renderTable([
    makeAsset({ id: 1, name: "Converted", currency: "EUR", current_value: "10", capital_value: "11", capital_currency: "USD" }),
    makeAsset({ id: 2, name: "Same currency", currency: "USD", current_value: "5", capital_value: "5", capital_currency: "USD" }),
  ]);

  expect(container.textContent).toContain("в капитале");
  const sameCurrencyRow = Array.from(container.querySelectorAll("li")).find((li) => li.textContent?.includes("Same currency"));
  expect(sameCurrencyRow?.textContent).not.toContain("в капитале");
});
