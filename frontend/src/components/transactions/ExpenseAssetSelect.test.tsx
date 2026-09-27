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

function mount(value: string, onChange = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ExpenseAssetSelect value={value} onChange={onChange} />
      </QueryClientProvider>,
    );
  });
  return { onChange };
}

it("keeps an already-linked value visibly linked while the asset list is still loading, not silently 'No link'", async () => {
  // A fetch that never resolves during this test — the component must not
  // fall back to "No link" just because `assets` is still undefined.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  mount("1");
  await settle();

  const select = container.querySelector("select") as HTMLSelectElement;
  // The controlled value is preserved (a real save right now would still
  // submit the real link) — checked via the DOM value, not just the React
  // prop, since a browser <select> falls back to the first option on its
  // own if no <option> matches the controlled value.
  expect(select.value).toBe("1");
  expect(select.value).not.toBe("");
});

it("shows a retry-able error instead of silently losing an existing link when the asset list fails to load", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response("Internal Server Error", { status: 500 })));
  vi.stubGlobal("fetch", fetchMock);
  mount("1");
  await settle();

  const select = container.querySelector("select") as HTMLSelectElement;
  expect(select.value).toBe("1"); // still not silently "No link"
  const alert = container.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();

  const retry = [...container.querySelectorAll("button")].find((b) => /Повторить|Retry/.test(b.textContent ?? ""));
  expect(retry).toBeDefined();
  const callsBeforeRetry = fetchMock.mock.calls.length;
  await act(async () => { retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
});

it("'No link' stays selectable (and clears the value) even while the list has failed to load", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("Internal Server Error", { status: 500 }))));
  const { onChange } = mount("1");
  await settle();

  const select = container.querySelector("select") as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, "");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("");
});
