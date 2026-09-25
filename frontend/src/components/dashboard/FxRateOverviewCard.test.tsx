import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FxRateOverviewCard } from "./FxRateOverviewCard";

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

async function renderWith(response: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => { root.render(<QueryClientProvider client={queryClient}><FxRateOverviewCard /></QueryClientProvider>); });
  // Several macrotask turns, not one — react-query's fetch -> setQueryData
  // -> re-render pipeline can take more than a single tick to settle.
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

it("shows the rate, publication date and source for an available currency", async () => {
  await renderWith({
    reporting_currency: "PLN", as_of: "2026-09-25",
    items: [{ currency: "USD", rate: "4.1000", rate_date: "2026-09-25", source: "NBP" }],
  });
  expect(container.textContent).toContain("USD");
  expect(container.textContent).toContain("NBP");
  expect(container.textContent).toMatch(/4[.,]1/);
});

it('shows an explicit "no rate" instead of a guessed 0 or 1:1 when a currency is unavailable', async () => {
  await renderWith({
    reporting_currency: "PLN", as_of: "2026-09-25",
    items: [{ currency: "RUB", rate: null, rate_date: null, source: null }],
  });
  expect(container.textContent).toContain("нет курса");
  expect(container.textContent).not.toContain("0");
  expect(container.textContent).not.toMatch(/\b1\s*[:/]\s*1\b/);
});

it("shows an older publication date for a weekly-published currency without treating it as an error", async () => {
  await renderWith({
    reporting_currency: "PLN", as_of: "2026-09-25",
    items: [{ currency: "BYN", rate: "1.2500", rate_date: "2026-09-23", source: "NBP" }],
  });
  expect(container.textContent).toContain("2026-09-23");
  expect(container.textContent).not.toContain("нет курса");
});

it('shows a clear "failed to load" state with a retry action instead of disappearing, and never fabricates values', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("Service unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      reporting_currency: "PLN", as_of: "2026-09-25",
      items: [{ currency: "USD", rate: "4.1000", rate_date: "2026-09-25", source: "NBP" }],
    }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => { root.render(<QueryClientProvider client={queryClient}><FxRateOverviewCard /></QueryClientProvider>); });
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить курсы");
  // Never shows a fabricated rate while the request is failing.
  expect(container.textContent).not.toContain("USD");

  const retryButton = container.querySelector("button");
  expect(retryButton).not.toBeNull();
  await act(async () => { retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  expect(container.textContent).toContain("USD");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("renders nothing while there is no data yet, rather than a misleading empty card", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => { root.render(<QueryClientProvider client={queryClient}><FxRateOverviewCard /></QueryClientProvider>); });
  expect(container.textContent).toBe("");
});
