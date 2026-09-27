import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecurringFormModal } from "./RecurringFormModal";

// Same underlying bug/fix as TransactionFormModal.test.tsx (see
// docs/tasks/income-tax-separation.md) — this modal's own whole-form init
// effect used to depend on `accounts` directly too, so a late/refetched
// accounts list silently wiped an already-picked mandatory-payment kind
// (ZUS/PPE) and amount on a brand-new template.

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
  { id: 21, name: "First account", currency: "USD", is_archived: false, balance: "0", type: "checking" },
  { id: 22, name: "Second account", currency: "USD", is_archived: false, balance: "0", type: "checking" },
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

function amountInput(): HTMLInputElement { return container.querySelector("#recurring-amount") as HTMLInputElement; }
function descriptionInput(): HTMLInputElement { return container.querySelector("#recurring-description") as HTMLInputElement; }
function accountSelect(): HTMLSelectElement { return container.querySelector("#recurring-account") as HTMLSelectElement; }
function mandatoryKindSelect(): HTMLSelectElement { return container.querySelector("#recurring-mandatory-kind") as HTMLSelectElement; }

/** Everything a fresh RecurringFormModal needs *except* GET /accounts,
 * which the caller controls the timing of via `resolveAccounts` — same
 * "modal opens, user types, THEN accounts resolves" repro as
 * TransactionFormModal.test.tsx. */
function stubFetchWithDeferredAccounts() {
  let resolveAccounts!: () => void;
  const accountsGate = new Promise<void>((resolve) => { resolveAccounts = resolve; });

  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/accounts")) {
      await accountsGate;
      return new Response(JSON.stringify(ACCOUNTS), { status: 200 });
    }
    if (url.includes("/api/settings")) {
      return new Response(JSON.stringify({ business_date: "2026-09-20", business_timezone: "Europe/Warsaw", currency: "USD" }), { status: 200 });
    }
    if (url.includes("/api/categories")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes("/api/assets")) return new Response(JSON.stringify([]), { status: 200 });
    return new Response("[]", { status: 200 });
  }));

  return { resolveAccounts: () => { resolveAccounts(); } };
}

async function mount(): Promise<QueryClient> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RecurringFormModal open onClose={vi.fn()} recurring={null} />
      </QueryClientProvider>,
    );
  });
  await settle();
  return queryClient;
}

it("a late GET /api/accounts arrival does not wipe a partially-filled ZUS template (kind + amount + description)", async () => {
  const { resolveAccounts } = stubFetchWithDeferredAccounts();
  await mount();
  expect(accountSelect().value).toBe("");

  await act(async () => { setValue(amountInput(), "300.00"); });
  await act(async () => { setValue(descriptionInput(), "ITS late-accounts ZUS template"); });
  await act(async () => { setValue(mandatoryKindSelect(), "zus"); });

  await act(async () => { resolveAccounts(); });
  await settle();

  expect(amountInput().value).toBe("300.00");
  expect(descriptionInput().value).toBe("ITS late-accounts ZUS template");
  expect(mandatoryKindSelect().value).toBe("zus");
  // The only field allowed to change: the still-blank account gets the
  // first available account as its default.
  expect(accountSelect().value).toBe("21");
});

it("a late GET /api/accounts arrival does not wipe a partially-filled PPE template", async () => {
  const { resolveAccounts } = stubFetchWithDeferredAccounts();
  await mount();

  await act(async () => { setValue(amountInput(), "150.75"); });
  await act(async () => { setValue(descriptionInput(), "ITS late-accounts PPE template"); });
  await act(async () => { setValue(mandatoryKindSelect(), "ppe"); });

  await act(async () => { resolveAccounts(); });
  await settle();

  expect(amountInput().value).toBe("150.75");
  expect(descriptionInput().value).toBe("ITS late-accounts PPE template");
  expect(mandatoryKindSelect().value).toBe("ppe");
  expect(accountSelect().value).toBe("21");
});

it("a background refetch of an already-loaded accounts list never overwrites a manually-picked account or the mandatory kind", async () => {
  let accountsFetches = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/accounts")) {
      accountsFetches += 1;
      const name = accountsFetches === 1 ? "First account" : "First account (renamed)";
      return new Response(JSON.stringify([{ ...ACCOUNTS[0], name }, ACCOUNTS[1]]), { status: 200 });
    }
    if (url.includes("/api/settings")) {
      return new Response(JSON.stringify({ business_date: "2026-09-20", business_timezone: "Europe/Warsaw", currency: "USD" }), { status: 200 });
    }
    if (url.includes("/api/categories")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes("/api/assets")) return new Response(JSON.stringify([]), { status: 200 });
    return new Response("[]", { status: 200 });
  }));

  const queryClient = await mount();
  expect(accountSelect().value).toBe("21");

  await act(async () => { setValue(accountSelect(), "22"); });
  await act(async () => { setValue(amountInput(), "77"); });
  await act(async () => { setValue(mandatoryKindSelect(), "vat"); });

  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["accounts"] }); });
  await settle();
  expect(accountsFetches).toBeGreaterThan(1);

  expect(accountSelect().value).toBe("22");
  expect(amountInput().value).toBe("77");
  expect(mandatoryKindSelect().value).toBe("vat");
});
