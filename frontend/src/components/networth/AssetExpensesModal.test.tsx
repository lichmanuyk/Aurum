import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssetExpensesModal } from "./AssetExpensesModal";
import type { Asset, AssetExpenseReport } from "@/types";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const ASSET: Asset = {
  id: 1, name: "Synthetic apartment", asset_class: "real_estate", currency: "USD", notes: null,
  capital_role: "neutral", monthly_cash_flow: null, risk_level: "medium", current_value: "200000",
  as_of_date: "2026-01-01", capital_value: "200000", capital_currency: "USD", capital_value_error: null,
};

const OTHER_ASSET: Asset = { ...ASSET, id: 2, name: "Synthetic car" };

function report(overrides: Partial<AssetExpenseReport> = {}): AssetExpenseReport {
  return {
    asset_id: 1, reporting_currency: "USD", start_date: null, end_date: "2026-09-27",
    total_amount: "150.00", transaction_count: 1, total: 1, page: 1, page_size: 10,
    items: [{
      id: 10, split_id: null, date: "2026-05-01", description: "Utility bill", merchant: null,
      account_id: 1, account_name: "Checking", account_currency: "USD", native_amount: "150.00",
      category_id: null, category_name: null, is_split: false, note: null, amount: "150.00",
    }],
    templates: [],
    ...overrides,
  };
}

function stubFetch(byAssetId: Record<number, AssetExpenseReport | { status: number }>) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/transactions/years")) return Promise.resolve(new Response("[2026]", { status: 200 }));
    const match = url.match(/\/assets\/(\d+)\/expenses/);
    if (match) {
      const body = byAssetId[Number(match[1])];
      if (body && "status" in body) return Promise.resolve(new Response("{}", { status: body.status }));
      if (body) return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    return Promise.resolve(new Response("[]", { status: 200 }));
  }));
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount(asset: Asset | null, onClose: () => void = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // retry: false — a failed request (e.g. FX_RATE_MISSING) must surface
  // immediately as an error state, not after react-query's default
  // multi-second exponential backoff.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssetExpensesModal open asset={asset} onClose={onClose} />
      </QueryClientProvider>,
    );
  });
  await settle();
  return queryClient;
}

it("shows the period total and recent payments once loaded", async () => {
  stubFetch({ 1: report() });
  await mount(ASSET);

  expect(container.textContent).toContain("Synthetic apartment");
  expect(container.textContent).toContain("Utility bill");
  expect(container.textContent).toMatch(/150/);
});

it("shows the empty-state hint when nothing is linked yet", async () => {
  stubFetch({ 1: report({ items: [], templates: [], total: 0, total_amount: "0" }) });
  await mount(ASSET);

  expect(container.textContent).toContain("Свяжите этот актив");
});

it("shows a retry-able error instead of a fabricated zero when the request fails", async () => {
  stubFetch({ 1: { status: 409 } });
  await mount(ASSET);

  const alert = container.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(container.textContent).not.toContain("0,00");
});

it("never shows a previous asset's stale total under the new asset's name", async () => {
  stubFetch({ 1: report({ total_amount: "150.00" }), 2: report({ asset_id: 2, total_amount: "999.00", items: [] }) });
  const queryClient = await mount(ASSET);
  expect(container.textContent).toContain("Synthetic apartment");
  expect(container.textContent).toMatch(/150/);

  // Switching the asset prop (as NetWorthPage does when a different row's
  // "Expenses" button is clicked) must never show the old asset's number
  // under the new asset's own name in the title.
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssetExpensesModal open asset={OTHER_ASSET} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  await settle();
  expect(container.textContent).toContain("Synthetic car");
  expect(container.textContent).toMatch(/999/);
  expect(container.textContent).not.toMatch(/150/);
});
