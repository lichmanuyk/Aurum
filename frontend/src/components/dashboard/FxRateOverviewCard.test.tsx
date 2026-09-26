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
