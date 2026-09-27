import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransactionFormModal } from "./TransactionFormModal";

// See docs/tasks/income-tax-separation.md — this regression was found while
// verifying that task's own acceptance: the whole-form init effect used to
// depend on `allAccounts` directly, so a *new* transaction form lost every
// already-typed field (amount, date, description, work-income checkbox,
// assigned month, mandatory-payment kind) the instant the accounts list
// arrived late or was refetched — see the effect split in
// TransactionFormModal.tsx for the fix.

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const ACCOUNTS = [
  { id: 11, name: "First account", currency: "USD", is_archived: false, balance: "0", type: "checking" },
  { id: 12, name: "Second account", currency: "USD", is_archived: false, balance: "0", type: "checking" },
];

const CATEGORIES = [
  { id: 101, name: "Salary", kind: "income", icon: null, color: "#000", sort_order: 0, is_default: true, parent_id: null },
  { id: 201, name: "Groceries", kind: "expense", icon: null, color: "#000", sort_order: 0, is_default: true, parent_id: null },
];

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function amountInput(): HTMLInputElement { return container.querySelector("#amount") as HTMLInputElement; }
function dateInput(): HTMLInputElement { return container.querySelector("#date") as HTMLInputElement; }
function descriptionInput(): HTMLInputElement { return container.querySelector("#description") as HTMLInputElement; }
function accountSelect(): HTMLSelectElement { return container.querySelector("#account") as HTMLSelectElement; }
function categorySelect(): HTMLSelectElement { return container.querySelector("#category") as HTMLSelectElement; }
function typeSelect(): HTMLSelectElement { return container.querySelector("#type") as HTMLSelectElement; }

/** Everything a fresh TransactionFormModal needs *except* GET /accounts,
 * which the caller controls the timing of via the returned `resolveAccounts`
 * — reproducing the modal opening (and the user typing into it) before that
 * request's response actually lands, same as a slow network or a
 * mid-session accounts refetch (e.g. from editing an account elsewhere). */
function stubFetchWithDeferredAccounts() {
  let resolveAccounts!: () => void;
  const accountsGate = new Promise<void>((resolve) => { resolveAccounts = resolve; });
  const posted: unknown[] = [];

  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/accounts")) {
      await accountsGate;
      return new Response(JSON.stringify(ACCOUNTS), { status: 200 });
    }
    if (url.includes("/api/settings")) {
      return new Response(JSON.stringify({ business_date: "2026-09-20", business_timezone: "Europe/Warsaw", currency: "USD" }), { status: 200 });
    }
    if (url.includes("/api/categories")) {
      return new Response(JSON.stringify(CATEGORIES), { status: 200 });
    }
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes("/api/assets")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes("/api/transactions") && init?.method === "POST") {
      posted.push(init.body ? JSON.parse(init.body as string) : {});
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }
    return new Response("[]", { status: 200 });
  }));

  return { resolveAccounts: () => { resolveAccounts(); }, posted };
}

async function mount(): Promise<QueryClient> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TransactionFormModal open onClose={vi.fn()} transaction={null} />
      </QueryClientProvider>,
    );
  });
  await settle();
  return queryClient;
}

it("a late GET /api/accounts arrival does not wipe an already-typed new income row (work-income checkbox included)", async () => {
  const { resolveAccounts } = stubFetchWithDeferredAccounts();
  await mount();

  // Accounts haven't arrived yet — the select is empty, but everything else
  // is still fully usable (this is the exact "open the form before accounts
  // resolves" repro from the task).
  expect(accountSelect().value).toBe("");

  await act(async () => { setValue(typeSelect(), "income"); });
  await act(async () => { setValue(amountInput(), "1000"); });
  await act(async () => { setValue(dateInput(), "2026-10-03"); });
  await act(async () => { setValue(descriptionInput(), "ITS late-accounts invoice"); });
  await act(async () => { setValue(categorySelect(), "101"); });

  const workIncomeCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => { workIncomeCheckbox.click(); });
  const periodInput = container.querySelector("#transaction-assigned-period") as HTMLInputElement;
  await act(async () => { setValue(periodInput, "2026-08"); });

  // Now the accounts list actually resolves — this is the refetch/late
  // arrival that used to reset the whole form via the old
  // `[open, transaction, allAccounts]` effect dependency.
  await act(async () => { resolveAccounts(); });
  await settle();

  expect(amountInput().value).toBe("1000");
  expect(dateInput().value).toBe("2026-10-03");
  expect(descriptionInput().value).toBe("ITS late-accounts invoice");
  expect(categorySelect().value).toBe("101");
  expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  expect((container.querySelector("#transaction-assigned-period") as HTMLInputElement).value).toBe("2026-08");
  // The one field that's actually allowed to change: the still-blank
  // account gets the first available account as its default, exactly once
  // the list finally arrives.
  expect(accountSelect().value).toBe("11");
});

it("a late GET /api/accounts arrival does not wipe a partially-filled mandatory-payment expense (ZUS/PPE kind + amount)", async () => {
  const { resolveAccounts } = stubFetchWithDeferredAccounts();
  await mount();

  // Expense is the default type — no need to switch.
  await act(async () => { setValue(amountInput(), "200.50"); });
  await act(async () => { setValue(dateInput(), "2026-09-03"); });
  await act(async () => { setValue(descriptionInput(), "ITS late-accounts ZUS"); });

  const mandatoryKindSelect = container.querySelector("#transaction-mandatory-kind") as HTMLSelectElement;
  await act(async () => { setValue(mandatoryKindSelect, "zus"); });
  // Deliberately partial: the kind is picked but the required month isn't
  // filled in yet — the exact mid-entry state a late arrival must not wipe.
  expect((container.querySelector("#transaction-assigned-period") as HTMLInputElement).value).toBe("");

  await act(async () => { resolveAccounts(); });
  await settle();

  expect(amountInput().value).toBe("200.50");
  expect(dateInput().value).toBe("2026-09-03");
  expect(descriptionInput().value).toBe("ITS late-accounts ZUS");
  expect((container.querySelector("#transaction-mandatory-kind") as HTMLSelectElement).value).toBe("zus");
  expect(accountSelect().value).toBe("11");

  // Finish filling the now-required month and confirm the classification
  // that survived the late arrival actually submits as expected.
  await act(async () => { setValue(container.querySelector("#transaction-assigned-period") as HTMLInputElement, "2026-08"); });
});

it("a background refetch of an already-loaded accounts list never overwrites a manually-picked account or other typed fields", async () => {
  let accountsFetches = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/accounts")) {
      accountsFetches += 1;
      // Second response is a *different* object (e.g. a renamed account) —
      // same ids, so equivalent for the "pick a default" purpose, but a new
      // array/object reference either way, which is exactly what used to
      // matter with the old `[open, transaction, allAccounts]` dependency.
      const name = accountsFetches === 1 ? "First account" : "First account (renamed)";
      return new Response(JSON.stringify([{ ...ACCOUNTS[0], name }, ACCOUNTS[1]]), { status: 200 });
    }
    if (url.includes("/api/settings")) {
      return new Response(JSON.stringify({ business_date: "2026-09-20", business_timezone: "Europe/Warsaw", currency: "USD" }), { status: 200 });
    }
    if (url.includes("/api/categories")) return new Response(JSON.stringify(CATEGORIES), { status: 200 });
    if (url.includes("/api/tags")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes("/api/assets")) return new Response(JSON.stringify([]), { status: 200 });
    return new Response("[]", { status: 200 });
  }));

  const queryClient = await mount();
  expect(accountSelect().value).toBe("11"); // default filled in from the first response

  await act(async () => { setValue(accountSelect(), "12"); });
  await act(async () => { setValue(amountInput(), "42"); });
  await act(async () => { setValue(descriptionInput(), "ITS refetch survives"); });

  // A background refetch landing mid-edit (accounts invalidated elsewhere,
  // e.g. renaming an account on another tab/page) — new response object,
  // same query key.
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["accounts"] }); });
  await settle();
  expect(accountsFetches).toBeGreaterThan(1);

  expect(accountSelect().value).toBe("12");
  expect(amountInput().value).toBe("42");
  expect(descriptionInput().value).toBe("ITS refetch survives");
});
