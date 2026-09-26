import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExpenseAssetSelect } from "./ExpenseAssetSelect";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const ASSETS = [
  { id: 1, name: "Synthetic apartment", asset_class: "real_estate", currency: "USD", notes: null,
    capital_role: "neutral", monthly_cash_flow: null, risk_level: "medium", current_value: "1", as_of_date: "2026-01-01",
    capital_value: "1", capital_currency: "USD", capital_value_error: null },
  { id: 2, name: "Synthetic coin", asset_class: "crypto", currency: "USD", notes: null,
    capital_role: "neutral", monthly_cash_flow: null, risk_level: "medium", current_value: "1", as_of_date: "2026-01-01",
    capital_value: "1", capital_currency: "USD", capital_value_error: null },
];

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

it("offers manually-tracked assets but never a crypto-class one, and reports the picked id", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(ASSETS), { status: 200 }))));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  const onChange = vi.fn();
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ExpenseAssetSelect value="" onChange={onChange} />
      </QueryClientProvider>,
    );
  });
  await settle();

  const select = container.querySelector("select") as HTMLSelectElement;
  const optionLabels = [...select.options].map((o) => o.textContent);
  expect(optionLabels).toContain("Synthetic apartment");
  // A crypto Asset row is always a CryptoHolding's own shell — never a
  // valid expense target (see routes/transactions.py's own
  // _ensure_expense_asset_valid) — offering it here would be a dead end.
  expect(optionLabels).not.toContain("Synthetic coin");

  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, "1");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("1");
});
