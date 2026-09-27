import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecurringPaymentModal } from "./RecurringPaymentModal";
import type { RecurringTransaction } from "@/types";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
// React 19's act() otherwise warns "environment is not configured to
// support act" under plain jsdom (no @testing-library/react wiring it up).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const RECURRING: RecurringTransaction = {
  destination_currency: null, currency: "USD", id: 7, account_id: 1, account_name: "Checking",
  category_id: null, category_name: null, category_color: null, category_icon: null,
  expense_asset_id: null,
  mandatory_payment_kind: null,
  transfer_account_id: null, transfer_account_name: null, type: "expense", amount: "10.00",
  description: "Electricity", merchant: null, notes: null, frequency: "monthly", anchor_date: "2026-01-01",
  last_posted_date: null, is_active: true, next_due_date: "2026-09-01", is_due: true, days_until_due: 0,
};

const ACCOUNTS = [
  { id: 1, name: "Checking", currency: "USD", is_archived: false, balance: "0", type: "checking" },
  { id: 2, name: "Savings", currency: "USD", is_archived: false, balance: "0", type: "checking" },
  { id: 3, name: "Euro wallet", currency: "EUR", is_archived: false, balance: "0", type: "checking" },
];

function stubFetch(handlePost: (body: unknown) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/accounts")) return Promise.resolve(new Response(JSON.stringify(ACCOUNTS), { status: 200 }));
    if (url.includes("/recurring") && init?.method === "POST") {
      return Promise.resolve(handlePost(init.body ? JSON.parse(init.body as string) : {}));
    }
    return Promise.resolve(new Response("[]", { status: 200 }));
  }));
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount(onClose: () => void = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RecurringPaymentModal open recurring={RECURRING} onClose={onClose} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function amountInput(): HTMLInputElement {
  return container.querySelector("#recurring-payment-amount") as HTMLInputElement;
}
function accountSelect(): HTMLSelectElement {
  return container.querySelector("#recurring-payment-account") as HTMLSelectElement;
}
function confirmButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((b) => b.type === "submit") as HTMLButtonElement;
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function submit() {
  const form = container.querySelector("form")!;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

it("cancels without posting anything", async () => {
  const posted = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
  stubFetch(posted);
  const onClose = vi.fn();
  await mount(onClose);

  const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "Отмена")!;
  await act(async () => { cancel.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(posted).not.toHaveBeenCalled();
});

it("shows the actual amount from the template, editable, and defaults to the template's own account", async () => {
  stubFetch(() => new Response("{}", { status: 201 }));
  await mount();
  expect(amountInput().value).toBe("10.00");
  expect(accountSelect().value).toBe("1");
});

it("clears the amount when switching to a different-currency account, but not for a same-currency one", async () => {
  stubFetch(() => new Response("{}", { status: 201 }));
  await mount();

  await act(async () => { setValue(accountSelect(), "2"); }); // USD -> USD
  expect(amountInput().value).toBe("10.00");

  await act(async () => { setValue(accountSelect(), "3"); }); // USD -> EUR
  expect(amountInput().value).toBe("");
  expect(container.textContent).toContain("Валюта счёта изменилась");
});

it("keeps the entered amount/account on a validation error so the user can correct and retry", async () => {
  const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Invalid amount" }), { status: 422 }));
  stubFetch(post);
  await mount();

  await act(async () => { setValue(amountInput(), "5"); });
  await act(async () => { submit(); });
  await settle();

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось провести платёж");
  expect(amountInput().value).toBe("5"); // input preserved for correction, not wiped
  expect(post).toHaveBeenCalledTimes(1);
});

it("disables the confirm button while a submission is pending and never double-posts", async () => {
  let resolvePost: (() => void) | null = null;
  const post = vi.fn(() => new Promise<Response>((resolve) => {
    resolvePost = () => resolve(new Response(JSON.stringify(RECURRING), { status: 201 }));
  }));
  stubFetch(post);
  await mount();

  await act(async () => { submit(); });
  expect(confirmButton().disabled).toBe(true);

  // A second submit attempt while pending must not fire a second POST.
  await act(async () => { submit(); });
  expect(post).toHaveBeenCalledTimes(1);

  await act(async () => { resolvePost!(); });
  await settle();
});

function conflict(code: string) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: { code } }), { status: 409 }));
}

it('shows a clear "already posted" message for an ALREADY_POSTED 409 and refreshes balances/reports, not just the template', async () => {
  const post = conflict("ALREADY_POSTED");
  let accountsFetches = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/accounts")) {
      accountsFetches += 1;
      return Promise.resolve(new Response(JSON.stringify(ACCOUNTS), { status: 200 }));
    }
    if (url.includes("/recurring") && init?.method === "POST") {
      return Promise.resolve(post(init.body ? JSON.parse(init.body as string) : {}));
    }
    return Promise.resolve(new Response("[]", { status: 200 }));
  }));
  await mount();
  const fetchesBeforeSubmit = accountsFetches;

  await act(async () => { submit(); });
  await settle();

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("уже проведён");
  // Retrying a request that's already conflicted is pointless — confirm stays disabled.
  expect(confirmButton().disabled).toBe(true);
  // A lost-but-successful response means a real Transaction exists that
  // this client doesn't know about — accounts (and everything else the
  // template's own onSuccess would refresh) must be pulled in too, not
  // just the recurring list.
  expect(accountsFetches).toBeGreaterThan(fetchesBeforeSubmit);
});

it.each(["TEMPLATE_NOT_DUE", "TEMPLATE_INACTIVE"])(
  "shows a distinct, non-\"already posted\" message for a %s 409 and does not refetch balances/reports",
  async (code) => {
    const post = conflict(code);
    let accountsFetches = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/accounts")) {
        accountsFetches += 1;
        return Promise.resolve(new Response(JSON.stringify(ACCOUNTS), { status: 200 }));
      }
      if (url.includes("/recurring") && init?.method === "POST") {
        return Promise.resolve(post(init.body ? JSON.parse(init.body as string) : {}));
      }
      return Promise.resolve(new Response("[]", { status: 200 }));
    }));
    await mount();
    const fetchesBeforeSubmit = accountsFetches;

    await act(async () => { submit(); });
    await settle();

    const alertText = container.querySelector('[role="alert"]')?.textContent;
    expect(alertText).not.toContain("уже проведён");
    expect(alertText).toContain("Шаблон отключён или срок ещё не наступил");
    expect(confirmButton().disabled).toBe(true);
    // Nothing was actually posted by this attempt — no reason to refresh
    // balances/transactions/reports, only the (possibly now-stale) template.
    expect(accountsFetches).toBe(fetchesBeforeSubmit);
  },
);
