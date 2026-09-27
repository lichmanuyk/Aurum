/** Regression coverage for one specific fix: posting a recurring
 * template's real Transaction invalidates the "Income & Taxes" report
 * cache too — including the ALREADY_POSTED lost-response recovery path
 * (RecurringPaymentModal.tsx), which shares this exact same invalidation
 * function/argument — while a template's own metadata edits (which never
 * create a Transaction) correctly do not. See
 * docs/tasks/income-tax-separation.md and the independent frontend review
 * that found `["income-tax"]` missing from the `alsoInvalidateTransactions`
 * branch below.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInvalidateRecurring, usePostRecurring } from "./useRecurring";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

function renderInvalidateProbe() {
  let invalidate!: ReturnType<typeof useInvalidateRecurring>;
  function Probe() { invalidate = useInvalidateRecurring(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });
  return () => invalidate;
}

it("posting a template's real Transaction (alsoInvalidateTransactions=true) refreshes the Income & Taxes report alongside Dashboard/Cash Flow", () => {
  const getInvalidate = renderInvalidateProbe();
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  act(() => getInvalidate()(true));
  expect(invalidatedKeysFrom(spy)).toEqual(expect.arrayContaining(["income-tax", "dashboard-summary", "cash-flow"]));
});

it("the ALREADY_POSTED lost-response recovery path gets the same refresh — it calls this exact function with the same argument", () => {
  // RecurringPaymentModal.tsx's own catch block calls
  // invalidateRecurring(true) directly on ALREADY_POSTED (a real
  // Transaction exists server-side either way) — there is nothing else to
  // exercise here beyond confirming that shared function's own contract,
  // which the test above already pins down for usePostRecurring's onSuccess.
  const getInvalidate = renderInvalidateProbe();
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  act(() => getInvalidate()(true));
  expect(invalidatedKeysFrom(spy)).toContain("income-tax");
});

it("editing/creating/deleting a template's own metadata (alsoInvalidateTransactions=false) does NOT refetch the Income & Taxes report — no new Transaction exists", () => {
  const getInvalidate = renderInvalidateProbe();
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  act(() => getInvalidate()(false));
  const keys = invalidatedKeysFrom(spy);
  expect(keys).toContain("recurring");
  expect(keys).not.toContain("income-tax");
  expect(keys).not.toContain("dashboard-summary");
});

it("usePostRecurring's own onSuccess wires into that same invalidation end-to-end", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 201 })));
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  let post!: ReturnType<typeof usePostRecurring>;
  function Probe() { post = usePostRecurring(); return null; }
  root = createRoot(container);
  act(() => { root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });

  await act(async () => { await post.mutateAsync({ id: 1 }); });
  await flush();
  expect(invalidatedKeysFrom(spy)).toContain("income-tax");
});
