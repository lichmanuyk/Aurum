/** Covers the two things most likely to silently regress: (1) a late-
 * arriving accounts list must never wipe text the user already typed —
 * the exact class of bug fixed for the transaction/recurring forms (see
 * "Fix late-accounts arrival wiping typed transaction/recurring form
 * fields" in git log) — and (2) a cross-currency new loan must require an
 * explicit actual account amount, never silently defaulting/inferring one
 * (see docs/tasks/debt-tracking.md and debt_amount_pair_violation). */
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { DebtFormModal } from "./DebtFormModal";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function counterpartyInput(): HTMLInputElement { return container.querySelector("#debt-counterparty") as HTMLInputElement; }
function fundingSelect(): HTMLSelectElement | null { return container.querySelector("#debt-funding") as HTMLSelectElement | null; }
function accountSelect(): HTMLSelectElement | null { return container.querySelector("#debt-account") as HTMLSelectElement | null; }

const ACCOUNTS = [
  { id: 1, name: "USD wallet", currency: "USD", is_archived: false, type: "checking", balance: "0" },
  { id: 2, name: "EUR wallet", currency: "EUR", is_archived: false, type: "checking", balance: "0" },
];

function stubFetchWithDeferredAccounts() {
  let resolveAccounts!: () => void;
  const gate = new Promise<void>((resolve) => { resolveAccounts = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/accounts")) {
      await gate;
      return new Response(JSON.stringify(ACCOUNTS), { status: 200 });
    }
    if (url.includes("/api/settings")) {
      return new Response(JSON.stringify({ business_date: "2024-06-01", business_timezone: "Europe/Warsaw" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  return { resolveAccounts: () => act(() => resolveAccounts()) };
}

function renderModal() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DebtFormModal open onClose={() => {}} debt={null} />
      </QueryClientProvider>
    );
  });
}

it("a late-arriving accounts list never wipes an already-typed counterparty name", async () => {
  const { resolveAccounts } = stubFetchWithDeferredAccounts();
  renderModal();
  await flush();

  act(() => setValue(counterpartyInput(), "Deferred friend"));
  expect(counterpartyInput().value).toBe("Deferred friend");

  resolveAccounts();
  await flush();

  expect(counterpartyInput().value).toBe("Deferred friend");
});

it("switching funding to a new loan with a different-currency account requires an explicit actual account amount", async () => {
  const { resolveAccounts } = stubFetchWithDeferredAccounts();
  renderModal();
  resolveAccounts();
  await flush();

  act(() => setValue(fundingSelect()!, "new_loan"));
  await flush();
  expect(accountSelect()).not.toBeNull();

  // Debt currency defaults to USD; picking the EUR account must reveal the
  // explicit actual-amount field instead of silently reusing the debt's
  // own principal as if a 1:1 rate applied.
  act(() => setValue(accountSelect()!, "2"));
  await flush();
  expect(container.querySelector("#debt-issuance-amount")).not.toBeNull();

  // The same-currency account never shows it — nothing to reconcile.
  act(() => setValue(accountSelect()!, "1"));
  await flush();
  expect(container.querySelector("#debt-issuance-amount")).toBeNull();
});
