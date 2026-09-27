/** Every debt/repayment mutation moves real cash or changes a debt's own
 * outstanding/status (see docs/tasks/debt-tracking.md) — this only checks
 * that each one invalidates the full shared set (accounts/transactions/
 * dashboard/cash-flow/net-worth) alongside this feature's own "debts"/
 * "debt-repayments" keys, the same "don't forget a derived cache" shape as
 * useTransactions.test.tsx's own Income & Taxes regression coverage. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useCreateDebt,
  useDebtRepaymentActions,
  useDeleteDebt,
  useUpdateDebt,
} from "./useDebts";
import type { DebtCreateInput, DebtUpdateInput } from "@/types";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 201 })));
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function invalidatedKeysFrom(spy: ReturnType<typeof vi.spyOn>): unknown[] {
  return spy.mock.calls.map((call: unknown[]) => (call[0] as { queryKey: unknown[] }).queryKey[0]);
}

const EXPECTED = ["debts", "debt-repayments", "accounts", "transactions", "dashboard-summary", "cash-flow", "net-worth-summary"];

const dummyCreate = {} as unknown as DebtCreateInput;
const dummyUpdate = {} as unknown as DebtUpdateInput;

it("creating a debt (opening balance or new loan) invalidates the full shared cache set", async () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let create!: ReturnType<typeof useCreateDebt>;
  function Probe() { create = useCreateDebt(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await create.mutateAsync(dummyCreate); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(EXPECTED));
});

it("editing a debt's metadata invalidates the full shared cache set", async () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let update!: ReturnType<typeof useUpdateDebt>;
  function Probe() { update = useUpdateDebt(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await update.mutateAsync({ id: 1, input: dummyUpdate }); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(EXPECTED));
});

it("deleting a debt invalidates the full shared cache set", async () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let del!: ReturnType<typeof useDeleteDebt>;
  function Probe() { del = useDeleteDebt(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await del.mutateAsync(1); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(EXPECTED));
});

it("recording a repayment, reversing it, editing its note and deleting it each invalidate the full shared cache set", async () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let actions!: ReturnType<typeof useDebtRepaymentActions>;
  function Probe() { actions = useDebtRepaymentActions(1); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await actions.create.mutateAsync({} as never); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(EXPECTED));

  spy.mockClear();
  await act(async () => { await actions.reverse.mutateAsync({ id: 1, input: {} as never }); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(EXPECTED));

  spy.mockClear();
  await act(async () => { await actions.updateNote.mutateAsync({ id: 1, input: { note: "x" } }); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(EXPECTED));

  spy.mockClear();
  await act(async () => { await actions.remove.mutateAsync(1); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(EXPECTED));
});
