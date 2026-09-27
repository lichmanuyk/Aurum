/** Regression coverage for one specific fix: every transaction write path
 * (create/update/delete/bulk-import) invalidating the "Income & Taxes"
 * report's cache alongside every other derived total — see
 * docs/tasks/income-tax-separation.md and the independent frontend review
 * that found `["income-tax"]` missing from this shared invalidation list.
 * Exercises the real exported hooks end-to-end (mutateAsync -> onSuccess),
 * not the private helper function directly, so a future refactor that
 * moves the invalidation elsewhere still gets caught here.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useBulkCreateTransactions,
  useCreateTransaction,
  useDeleteTransaction,
  useUpdateTransaction,
} from "./useTransactions";
import type { TransactionInput } from "@/types";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Body content is irrelevant to every test here — only the mutation's
  // own onSuccess-driven invalidation is under test, never the request
  // shape or response body.
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

const dummyInput = {} as unknown as TransactionInput;

it("creating a transaction invalidates the Income & Taxes report cache, not just Cash Flow/Dashboard", async () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let create!: ReturnType<typeof useCreateTransaction>;
  function Probe() { create = useCreateTransaction(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await create.mutateAsync(dummyInput); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(["income-tax", "dashboard-summary", "cash-flow"]));
});

it("editing a transaction (e.g. reclassifying it as a mandatory tax payment, or clearing one) invalidates the Income & Taxes report cache", async () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let update!: ReturnType<typeof useUpdateTransaction>;
  function Probe() { update = useUpdateTransaction(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await update.mutateAsync({ id: 1, input: dummyInput }); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toContain("income-tax");
});

it("deleting a transaction invalidates the Income & Taxes report cache", async () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let del!: ReturnType<typeof useDeleteTransaction>;
  function Probe() { del = useDeleteTransaction(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await del.mutateAsync(1); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toContain("income-tax");
});

it("a bulk CSV import invalidates the Income & Taxes report cache — an imported row can carry assigned_period/mandatory_payment_kind too", async () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let bulk!: ReturnType<typeof useBulkCreateTransactions>;
  function Probe() { bulk = useBulkCreateTransactions(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await bulk.mutateAsync([dummyInput]); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toContain("income-tax");
});
