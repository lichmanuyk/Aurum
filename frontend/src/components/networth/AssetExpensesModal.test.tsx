import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssetExpensesModal } from "./AssetExpensesModal";
import type { Asset, AssetExpenseReport, RecurringTransaction } from "@/types";

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

const TEMPLATE_A: RecurringTransaction = {
  destination_currency: null, currency: "USD", id: 5, account_id: 1, account_name: "Checking",
  category_id: null, category_name: null, category_color: null, category_icon: null,
  expense_asset_id: ASSET.id, transfer_account_id: null, transfer_account_name: null, type: "expense",
  amount: "20.00", description: "Old template A payment", merchant: null, notes: null, frequency: "monthly",
  anchor_date: "2026-01-01", last_posted_date: null, is_active: true, next_due_date: "2026-09-01",
  is_due: true, days_until_due: 0,
};

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

it("never offers a stale payment for a previous asset at the very first render of a new one — before any effect settles", async () => {
  stubFetch({
    1: report({ items: [], templates: [TEMPLATE_A] }),
    2: report({ asset_id: 2, items: [], templates: [] }),
  });
  const queryClient = await mount(ASSET);

  // Open the payment modal for asset 1's own template.
  const payButton = [...container.querySelectorAll("button")]
    .find((b) => /Провести платёж|Post now/.test(b.textContent ?? ""));
  expect(payButton).toBeDefined();
  act(() => { payButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  // The payment dialog's own title ("Оплата: …"/"Payment: …") renders
  // synchronously from state, no network round-trip needed to show it.
  expect(container.textContent).toContain("Old template A payment");

  // Switch straight to a *different* asset — deliberately no `await
  // settle()` here: this must hold on the very same render the new props
  // land on, driven by validPayment's synchronous
  // `payingTemplate.expense_asset_id === asset.id` check
  // (AssetExpensesModal.tsx), not by a useEffect that only runs after
  // paint.
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssetExpensesModal open asset={OTHER_ASSET} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  expect(container.textContent).not.toContain("Old template A payment");
  // The report dialog itself is showing again immediately too (not
  // suspended behind a payment that no longer belongs here).
  expect(container.textContent).toContain("Synthetic car");

  await settle();
  expect(container.textContent).not.toContain("Old template A payment");
});

it("switching A -> B -> back to A never resurrects A's own payment on its own", async () => {
  // The synchronous validPayment guard alone only hides a stale payment
  // while looking at the *other* asset — without the [open, asset?.id]
  // effect below also clearing payingTemplate itself when the asset
  // actually changes, going back to the *original* asset would find that
  // untouched state object matching validPayment's own check again and
  // silently reopen a payment the user never resumed.
  stubFetch({
    1: report({ items: [], templates: [TEMPLATE_A] }),
    2: report({ asset_id: 2, items: [], templates: [] }),
  });
  const queryClient = await mount(ASSET); // asset A (id 1)

  const payButton = [...container.querySelectorAll("button")]
    .find((b) => /Провести платёж|Post now/.test(b.textContent ?? ""));
  act(() => { payButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const paymentTitle = /Оплата: Old template A payment|Payment: Old template A payment/;
  expect(container.textContent).toMatch(paymentTitle);

  // Switch to asset B and let the reset effect actually run.
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssetExpensesModal open asset={OTHER_ASSET} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  await settle();
  expect(container.textContent).not.toMatch(paymentTitle);

  // Switch back to the original asset A.
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssetExpensesModal open asset={ASSET} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  await settle();
  // The template is still legitimately listed (same asset, same link) —
  // only its payment must not have reopened by itself.
  expect(container.textContent).toContain("Old template A payment");
  expect(container.textContent).not.toMatch(paymentTitle);
});

it("clears a pending payment once this dialog closes (open -> false), not only lazily on the next open", async () => {
  // Defense-in-depth: today's only wiring (NetWorthPage) always closes
  // through handleClose, which already clears this synchronously — this
  // test instead flips `open` straight through props, the way *any* other
  // future caller might, to prove the dialog cleans up regardless of how
  // it was told to close (see AssetExpensesModal.tsx's own `[open]` effect).
  stubFetch({ 1: report({ items: [], templates: [TEMPLATE_A] }) });
  const onClose = vi.fn();
  const queryClient = await mount(ASSET, onClose);

  const payButton = [...container.querySelectorAll("button")]
    .find((b) => /Провести платёж|Post now/.test(b.textContent ?? ""));
  act(() => { payButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  // The payment dialog's own title ("Оплата: …"/"Payment: …"), not just
  // the template's bare description — that description alone would also
  // legitimately appear in the report's own templates list regardless of
  // whether a payment is pending for it, so it can't tell the two apart.
  const paymentTitle = /Оплата: Old template A payment|Payment: Old template A payment/;
  expect(container.textContent).toMatch(paymentTitle);

  // The parent closes the whole dialog outright (open: true -> false)
  // while the payment was still pending.
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssetExpensesModal open={false} asset={ASSET} onClose={onClose} />
      </QueryClientProvider>,
    );
  });
  await settle(); // let the `[open]` cleanup effect run

  // Reopening the *same* asset afterwards must never resurrect the old
  // payment — without the cleanup effect, payingTemplate would still
  // match validPayment's own asset check and reopen it unasked. The
  // template's description legitimately reappears in the templates list
  // (same asset, same linked template) — only the payment dialog's own
  // title must not.
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssetExpensesModal open asset={ASSET} onClose={onClose} />
      </QueryClientProvider>,
    );
  });
  expect(container.textContent).not.toMatch(paymentTitle);
  expect(container.textContent).toContain("Old template A payment"); // still listed as a template, just not mid-payment
});
