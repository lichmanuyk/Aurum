import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useBusinessDate, useInvalidateOnBusinessDateChange } from "./useBusinessDate";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));

// React 19's act() otherwise warns "environment is not configured to
// support act" under plain jsdom (no @testing-library/react wiring it up)
// — same setup as lib/displayCurrency.test.tsx.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function settingsResponse(businessDate: string) {
  return {
    currency: "PLN",
    negative_cash_flow_threshold_months: 2,
    net_worth_decline_threshold_months: 2,
    risky_allocation_threshold_percent: 20,
    idle_cash_threshold_amount: "1000",
    idle_cash_threshold_currency: "PLN",
    idle_cash_threshold_days: 60,
    summary_currency: null,
    dashboard_currency: null,
    net_worth_currency: null,
    crypto_currency: null,
    cash_flow_currency: null,
    reports_currency: null,
    app_version: "test",
    business_date: businessDate,
    business_timezone: "Europe/Warsaw",
  };
}

/** Serves GET /api/settings — succeeds with whatever `queue` currently
 * holds at the front (shifting it forward each call), or rejects if
 * `queue` is empty. Lets a test script an exact sequence of business
 * dates/failures across successive fetches without needing real timers or
 * react-query's own refetchInterval to actually elapse. */
function mockSettingsSequence(queue: Array<string | "error">) {
  vi.stubGlobal("fetch", vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("mockSettingsSequence: queue exhausted");
    if (next === "error") throw new TypeError("Network request failed");
    return new Response(JSON.stringify(settingsResponse(next)), { status: 200 });
  }));
}

async function flush() {
  // Several macrotask turns, not one — react-query's fetch -> setQueryData
  // -> re-render pipeline can take more than a single tick to settle (same
  // as lib/displayCurrency.test.tsx's own flush()).
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let root: Root | undefined;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = undefined;
  // retry: 0 — a scripted "error" response must surface as isError on the
  // very next flush, not get silently retried away first.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderBusinessDateProbe(): { latest: () => ReturnType<typeof useBusinessDate> } {
  let latestState: ReturnType<typeof useBusinessDate> | undefined;
  function Probe() {
    latestState = useBusinessDate();
    return null;
  }
  root = createRoot(container);
  act(() => {
    root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
  });
  return { latest: () => latestState! };
}

it("businessDate starts undefined — never a client-guessed fallback — and fills in after the first successful read", async () => {
  mockSettingsSequence(["2026-09-27"]);
  const probe = renderBusinessDateProbe();

  expect(probe.latest().businessDate).toBeUndefined();
  await flush();
  expect(probe.latest().businessDate).toBe("2026-09-27");
  expect(probe.latest().businessTimezone).toBe("Europe/Warsaw");
  expect(probe.latest().isError).toBe(false);
});

it("isError is true and businessDate stays undefined when the source is unavailable; retry() recovers", async () => {
  mockSettingsSequence(["error", "2026-09-27"]);
  const probe = renderBusinessDateProbe();

  await flush();
  expect(probe.latest().isError).toBe(true);
  expect(probe.latest().businessDate).toBeUndefined();

  act(() => probe.latest().refetch());
  await flush();
  expect(probe.latest().isError).toBe(false);
  expect(probe.latest().businessDate).toBe("2026-09-27");
});

it("a background refetch failure after a prior success does not resurrect yesterday's cached date as a confirmed 'today' — isError and businessDate=undefined together, until a successful retry", async () => {
  mockSettingsSequence(["2026-09-27", "error", "2026-09-28"]);
  const probe = renderBusinessDateProbe();

  await flush(); // initial success: day N cached
  expect(probe.latest().businessDate).toBe("2026-09-27");
  expect(probe.latest().isError).toBe(false);

  // A later refetch (the 60s poll, a window refocus, reconnect, ...)
  // fails — react-query's own reducer leaves day N's `data` sitting in
  // the cache (see query-core's `case 'error'`, which never clears
  // `data`), which must not surface here as if it were still a
  // trustworthy "today".
  act(() => probe.latest().refetch());
  await flush();
  expect(probe.latest().isError).toBe(true);
  expect(probe.latest().businessDate).toBeUndefined();
  expect(probe.latest().businessTimezone).toBeUndefined();

  // A successful retry recovers day N+1 — isError clears and the fresh
  // date replaces the hidden-stale one, together, in the same update.
  act(() => probe.latest().refetch());
  await flush();
  expect(probe.latest().isError).toBe(false);
  expect(probe.latest().businessDate).toBe("2026-09-28");
});

function renderInvalidateHarness() {
  function Harness() {
    useInvalidateOnBusinessDateChange();
    return null;
  }
  root = createRoot(container);
  act(() => {
    root!.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
  });
}

it("never invalidates on the very first load — nothing cached yet is 'stale'", async () => {
  mockSettingsSequence(["2026-09-27"]);
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  renderInvalidateHarness();

  await flush();
  expect(invalidateSpy).not.toHaveBeenCalled();
});

it("invalidates the date-sensitive keys exactly once when the business date actually advances, and not again for a same-date refetch", async () => {
  mockSettingsSequence(["2026-09-27", "2026-09-27", "2026-09-28", "2026-09-28"]);
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  renderInvalidateHarness();
  await flush(); // first load: 2026-09-27, no invalidation

  // A poll that finds the same day still current (the queue's second
  // "2026-09-27") — simulates useBusinessDate's own refetchInterval firing
  // without needing real/fake timers to actually elapse 60s.
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ["settings"] });
  });
  await flush();
  expect(invalidateSpy).not.toHaveBeenCalled();

  // The day actually advances (the queue's "2026-09-28") — exactly one
  // invalidate call per date-sensitive key, not per poll.
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ["settings"] });
  });
  await flush();
  const invalidatedKeys = invalidateSpy.mock.calls.map((call) => (call[0] as { queryKey: unknown[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining([
    "dashboard-summary", "net-worth-summary", "assets", "crypto-holdings",
    "crypto-history", "asset-expenses", "recurring", "financial-alerts",
    "advice", "fx-coverage", "quote-status", "fx-rate-period-overview", "transaction-years",
  ]));
  // "budget-status"/"cash-flow"/"category-ranking" are deliberately not
  // invalidated here — see useBusinessDate.ts's own docstring on why
  // (explicit params already do the job, or a changed queryKey already
  // will).
  expect(invalidatedKeys).not.toEqual(expect.arrayContaining(["budget-status"]));
  const callCountAfterFirstAdvance = invalidateSpy.mock.calls.length;

  // Another poll that still finds 2026-09-28 current (the queue's fourth
  // entry) — no further invalidation.
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ["settings"] });
  });
  await flush();
  expect(invalidateSpy.mock.calls.length).toBe(callCountAfterFirstAdvance);
});

/** Mounts one *active* `useQuery` per given key — plain string keys, since
 * `invalidateQueries({ queryKey: [prefix] })` partial-matches any longer
 * key starting with that prefix (e.g. the real `["asset-expenses", id,
 * filters]`) the same way. Each queryFn bumps and returns its own call
 * count, so a test can assert "refetched" as "count went up" without
 * needing the real endpoint shapes. */
function renderQueryProbes(keys: string[]): { fetchCounts: () => Record<string, number> } {
  const fetchCounts: Record<string, number> = {};
  function Probes() {
    for (const key of keys) {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- `keys` is a
      // fixed literal per test, never changes shape across renders here.
      useQuery({
        queryKey: [key],
        queryFn: async () => {
          fetchCounts[key] = (fetchCounts[key] ?? 0) + 1;
          return { calls: fetchCounts[key] };
        },
        // Never independently stale/refetching on its own — the only thing
        // that should trigger a refetch here is invalidateQueries from
        // useInvalidateOnBusinessDateChange.
        staleTime: Infinity,
      });
    }
    return null;
  }
  function Harness() {
    useInvalidateOnBusinessDateChange();
    return <Probes />;
  }
  root = createRoot(container);
  act(() => {
    root!.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
  });
  return { fetchCounts: () => ({ ...fetchCounts }) };
}

it("actually refetches mounted assets/crypto-holdings/crypto-history/asset-expenses queries on a business-date advance, and does not on a same-date poll", async () => {
  mockSettingsSequence(["2026-09-27", "2026-09-27", "2026-09-28", "2026-09-28"]);
  const keys = ["assets", "crypto-holdings", "crypto-history", "asset-expenses"];
  const probe = renderQueryProbes(keys);

  await flush(); // first load: 2026-09-27, plus each probe's own initial fetch
  const initialCounts = probe.fetchCounts();
  for (const key of keys) expect(initialCounts[key]).toBe(1);
  // "settings" itself is never in the invalidation list (it would recurse
  // into re-invalidating itself on every one of its own refetches).
  expect(initialCounts["settings"]).toBeUndefined();

  // Same-date poll (queue's second "2026-09-27") — none of the four probes
  // should refetch.
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ["settings"] });
  });
  await flush();
  expect(probe.fetchCounts()).toEqual(initialCounts);

  // The day actually advances (queue's "2026-09-28") — exactly one more
  // fetch per probe.
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ["settings"] });
  });
  await flush();
  const afterAdvance = probe.fetchCounts();
  for (const key of keys) expect(afterAdvance[key]).toBe(2);

  // Another same-date poll (queue's fourth "2026-09-28") — no further
  // refetch for any of the four.
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ["settings"] });
  });
  await flush();
  expect(probe.fetchCounts()).toEqual(afterAdvance);
});
