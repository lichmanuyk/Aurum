import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FxRateOverviewCard } from "./FxRateOverviewCard";
import type { FxRatePeriodOverviewResponse } from "@/hooks/useFxRatePeriodOverview";

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

function directPair(overrides: Partial<FxRatePeriodOverviewResponse["items"][number]> = {}) {
  return {
    base_currency: "USD", quote_currency: "PLN",
    value: "4.1000", unavailable_reason: null,
    legs: [{ currency: "USD", rate_date: "2026-09-25", source: "NBP:A:1" }],
    series: [{ date: "2026-09-25", value: "4.1" }],
    coverage_expected_days: 1, coverage_available_days: 1,
    ...overrides,
  };
}

function renderCard(response: unknown, props: { year?: number | null; month?: number | null } = {}) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })));
  return mountCard(props);
}

function mountCard(props: { year?: number | null; month?: number | null } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <FxRateOverviewCard year={props.year ?? null} month={props.month ?? null} />
      </QueryClientProvider>,
    );
  });
  return settle();
}

async function settle() {
  // Several macrotask turns, not one — react-query's fetch -> setQueryData
  // -> re-render pipeline can take more than a single tick to settle.
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

it("shows the rate, publication date and source for an available pair", async () => {
  await renderCard({
    mode: "latest", label: "latest", start_date: null, end_date: "2026-09-25",
    series_start: "2026-08-27", series_end: "2026-09-25",
    items: [directPair()],
  });
  expect(container.textContent).toContain("USD");
  expect(container.textContent).toContain("PLN");
  expect(container.textContent).toContain("NBP");
  expect(container.textContent).toMatch(/4[.,]1/);
});

it('shows "insufficient history" and a load action instead of a guessed 0 or 1:1 when a pair is unavailable', async () => {
  await renderCard({
    mode: "latest", label: "latest", start_date: null, end_date: "2026-09-25",
    series_start: "2026-08-27", series_end: "2026-09-25",
    items: [directPair({
      base_currency: "USD", quote_currency: "BYN", value: null, unavailable_reason: "fx_rate_missing",
      legs: [], series: [{ date: "2026-09-25", value: null }],
      coverage_expected_days: 1, coverage_available_days: 0,
    })],
  });
  expect(container.textContent).toContain("Недостаточно истории");
  expect(container.textContent).not.toMatch(/\b0\b/);
  expect(container.textContent).not.toMatch(/\b1\s*[:/]\s*1\b/);
  expect(container.querySelector("button")?.textContent).toContain("Загрузить курсы за период");
});

it("keeps neighbouring available pairs visible when one pair is unavailable", async () => {
  await renderCard({
    mode: "latest", label: "latest", start_date: null, end_date: "2026-09-25",
    series_start: "2026-08-27", series_end: "2026-09-25",
    items: [
      directPair(),
      directPair({
        base_currency: "USD", quote_currency: "RUB", value: null, unavailable_reason: "incomplete_coverage",
        legs: [], series: [{ date: "2026-09-25", value: null }],
        coverage_expected_days: 1, coverage_available_days: 0,
      }),
    ],
  });
  expect(container.textContent).toMatch(/4[.,]1/);
  expect(container.textContent).toContain("Недостаточно истории");
});

it("labels an average-mode value by period instead of a single publication date", async () => {
  await renderCard({
    mode: "average", label: "ytd", start_date: "2026-01-01", end_date: "2026-09-25",
    series_start: "2026-01-01", series_end: "2026-09-25",
    items: [directPair({ legs: [], value: "4.2000" })],
  });
  expect(container.textContent).toContain("среднее с начала года");
});

it('shows a clear "failed to load" state with a retry action instead of disappearing, and never fabricates values', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("Service unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      mode: "latest", label: "latest", start_date: null, end_date: "2026-09-25",
      series_start: "2026-08-27", series_end: "2026-09-25",
      items: [directPair()],
    }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await mountCard();

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить курсы");
  // Never shows a fabricated rate while the request is failing.
  expect(container.textContent).not.toContain("USD");

  const retryButton = container.querySelector("button");
  expect(retryButton).not.toBeNull();
  await act(async () => { retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();

  expect(container.textContent).toContain("USD");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("renders nothing while there is no data yet, rather than a misleading empty card", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  await mountCard();
  expect(container.textContent).toBe("");
});

it("still offers the load action when the headline value is available but the sparkline itself has a coverage gap", async () => {
  await renderCard({
    mode: "latest", label: "latest", start_date: null, end_date: "2026-09-25",
    series_start: "2026-08-27", series_end: "2026-09-25",
    items: [directPair({
      // The *last* day resolved (so `value` is available), but most of
      // the 30-day sparkline window behind it didn't — this must still
      // surface the load action, not just an unavailable headline.
      value: "4.1000", coverage_expected_days: 30, coverage_available_days: 3,
    })],
  });
  expect(container.textContent).toMatch(/4[.,]1/);
  expect(container.querySelector("button")?.textContent).toContain("Загрузить курсы за период");
});

it("resumes a failed multi-chunk load from the interval that failed, without re-requesting the already-saved one", async () => {
  const overview = {
    mode: "average", label: "average", start_date: "2024-01-01", end_date: "2024-12-31",
    series_start: "2024-01-01", series_end: "2024-12-31",
    items: [directPair({
      value: null, unavailable_reason: "incomplete_coverage", legs: [],
      series: [{ date: "2024-01-01", value: null }], coverage_expected_days: 366, coverage_available_days: 0,
    })],
  };
  const nbpCalls: { start_date: string; end_date: string }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/fx-rates/overview/period")) {
      return Promise.resolve(new Response(JSON.stringify(overview), { status: 200 }));
    }
    const body = JSON.parse(init!.body as string) as { start_date: string; end_date: string };
    nbpCalls.push({ start_date: body.start_date, end_date: body.end_date });
    // The second POST ever made fails; everything else succeeds — the
    // very first chunk is already saved by the time the failure happens.
    if (nbpCalls.length === 2) return Promise.resolve(new Response("Service unavailable", { status: 503 }));
    return Promise.resolve(new Response(JSON.stringify({ saved: 0, protected: 0, absent_currencies: [] }), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  await mountCard();

  const loadButton = container.querySelector("button")!;
  await act(async () => { loadButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  expect(nbpCalls.length).toBe(2); // one saved chunk, then the failing one — the mutation stops there
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить курсы за период");
  const savedChunk = { ...nbpCalls[0] };

  await act(async () => { loadButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();

  expect(container.querySelector('[role="alert"]')).toBeNull();
  // The chunk that already succeeded is never re-requested...
  expect(nbpCalls.filter((c) => c.start_date === savedChunk.start_date && c.end_date === savedChunk.end_date)).toHaveLength(1);
  // ...but the retry still picks up from where it failed and keeps going,
  // covering the rest of the (multi-chunk, >93-day) period.
  expect(nbpCalls.length).toBeGreaterThan(2);
});

it("reflects a partial success in the card's own coverage even when the next interval then fails", async () => {
  const insufficient = {
    mode: "average", label: "average", start_date: "2024-01-01", end_date: "2024-12-31",
    series_start: "2024-01-01", series_end: "2024-12-31",
    items: [directPair({
      value: null, unavailable_reason: "incomplete_coverage", legs: [],
      series: [{ date: "2024-01-01", value: null }], coverage_expected_days: 366, coverage_available_days: 0,
    })],
  };
  // What the first (successful) chunk's own save should make visible —
  // still short of full coverage, but no longer "no data at all".
  const afterFirstChunk = {
    ...insufficient,
    items: [directPair({
      value: "4.1000", unavailable_reason: null, legs: [{ currency: "USD", rate_date: "2024-12-31", source: "NBP:A:1" }],
      series: [{ date: "2024-01-01", value: null }, { date: "2024-12-31", value: "4.1" }],
      coverage_expected_days: 366, coverage_available_days: 93,
    })],
  };
  let getCalls = 0;
  const nbpCalls: { start_date: string; end_date: string }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/fx-rates/overview/period")) {
      getCalls += 1;
      return Promise.resolve(new Response(JSON.stringify(getCalls === 1 ? insufficient : afterFirstChunk), { status: 200 }));
    }
    const body = JSON.parse(init!.body as string) as { start_date: string; end_date: string };
    nbpCalls.push({ start_date: body.start_date, end_date: body.end_date });
    if (nbpCalls.length === 2) return Promise.resolve(new Response("Service unavailable", { status: 503 }));
    return Promise.resolve(new Response(JSON.stringify({ saved: 0, protected: 0, absent_currencies: [] }), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  await mountCard();
  expect(container.textContent).toContain("Недостаточно истории");

  const loadButton = container.querySelector("button")!;
  await act(async () => { loadButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();

  // The first chunk's save is already visible via the card's own
  // coverage/value, even though the very next interval then failed.
  expect(container.textContent).toMatch(/4[.,]1/);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить курсы за период");
});

it("shows the interval currently being fetched while a load is in flight", async () => {
  const overview = {
    mode: "latest", label: "latest", start_date: null, end_date: "2026-09-25",
    series_start: "2026-08-27", series_end: "2026-09-25",
    items: [directPair({
      value: null, unavailable_reason: "fx_rate_missing", legs: [],
      series: [{ date: "2026-09-25", value: null }], coverage_expected_days: 30, coverage_available_days: 0,
    })],
  };
  let resolvePost: (() => void) | null = null;
  const fetchMock = vi.fn((url: string) => {
    if (url.includes("/fx-rates/overview/period")) return Promise.resolve(new Response(JSON.stringify(overview), { status: 200 }));
    return new Promise<Response>((resolve) => {
      resolvePost = () => resolve(new Response(JSON.stringify({ saved: 0, protected: 0, absent_currencies: [] }), { status: 200 }));
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  await mountCard();

  const loadButton = container.querySelector("button")!;
  await act(async () => { loadButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();

  const status = container.querySelector('[role="status"]');
  expect(status?.textContent).toContain("2026-09-25");
  expect(loadButton.textContent).toContain("Загрузка курсов");

  expect(resolvePost).not.toBeNull();
  await act(async () => { resolvePost!(); });
  await settle();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("never keeps a previous period's load progress or error visible after switching to a different period", async () => {
  const periodA = {
    mode: "latest", label: "latest", start_date: null, end_date: "2026-09-25",
    series_start: "2026-08-27", series_end: "2026-09-25",
    items: [directPair({
      value: null, unavailable_reason: "fx_rate_missing", legs: [],
      series: [{ date: "2026-09-25", value: null }], coverage_expected_days: 30, coverage_available_days: 0,
    })],
  };
  const periodB = {
    mode: "average", label: "average", start_date: "2025-01-01", end_date: "2025-01-31",
    series_start: "2025-01-01", series_end: "2025-01-31",
    items: [directPair({
      value: null, unavailable_reason: "incomplete_coverage", legs: [],
      series: [{ date: "2025-01-01", value: null }], coverage_expected_days: 31, coverage_available_days: 0,
    })],
  };
  const fetchMock = vi.fn((url: string) => {
    if (url.includes("year=2025")) return Promise.resolve(new Response(JSON.stringify(periodB), { status: 200 }));
    if (url.includes("/fx-rates/overview/period")) return Promise.resolve(new Response(JSON.stringify(periodA), { status: 200 }));
    return Promise.resolve(new Response("Service unavailable", { status: 503 })); // any NBP load for period A fails
  });
  vi.stubGlobal("fetch", fetchMock);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => {
    root.render(<QueryClientProvider client={queryClient}><FxRateOverviewCard year={null} month={null} /></QueryClientProvider>);
  });
  await settle();

  const loadButton = container.querySelector("button")!;
  await act(async () => { loadButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить курсы за период");

  act(() => {
    root.render(<QueryClientProvider client={queryClient}><FxRateOverviewCard year={2025} month={1} /></QueryClientProvider>);
  });
  await settle();

  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
});
