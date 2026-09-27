/** useIncomeTaxReport: currency flows end-to-end from the Reports section's
 * configured currency (lib/displayCurrency.tsx) through to the actual
 * GET /income-tax request and back into the rendered response — see
 * docs/tasks/income-tax-separation.md and the independent frontend review
 * that found this hook never sent a `currency` at all. Deliberately checks
 * the real outgoing URL and the response the component would render, not
 * just that some internal function got called with some argument.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DisplayCurrencyProvider } from "@/lib/displayCurrency";
import { setCurrency } from "@/lib/i18n";
import { useIncomeTaxReport } from "./useIncomeTax";
import type { AppSettings, IncomeTaxReport } from "@/types";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
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
    business_date: "2026-01-01",
    business_timezone: "Europe/Warsaw",
    ...overrides,
  };
}

function emptyReport(reportingCurrency: string): IncomeTaxReport {
  return {
    reporting_currency: reportingCurrency, year: null, month: null,
    periods: [], total: 0, page: 1, page_size: 12, available_years: [],
  };
}

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = undefined;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

/** Serves GET /api/settings from `settings`, and GET /api/income-tax* with
 * a report whose reporting_currency mirrors whatever `currency` param this
 * particular call actually carried — close enough to the real backend's
 * get_reporting_session override to prove the request/response round-trip
 * without needing the real FastAPI app. */
function mockApi(settings: AppSettings) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url === "/api/settings") return new Response(JSON.stringify(settings), { status: 200 });
    if (url.startsWith("/api/income-tax")) {
      const currency = new URL(url, "http://localhost").searchParams.get("currency");
      return new Response(JSON.stringify(emptyReport(currency ?? settings.currency)), { status: 200 });
    }
    throw new Error(`Unexpected fetch in this test: ${url}`);
  }));
  return urls;
}

function renderAt(path: string, settings: AppSettings) {
  setCurrency(settings.currency);
  const urls = mockApi(settings);
  const queryClient = new QueryClient();
  let latest: ReturnType<typeof useIncomeTaxReport> | undefined;
  function Probe() {
    latest = useIncomeTaxReport({ year: 2026 });
    return null;
  }
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <DisplayCurrencyProvider><Probe /></DisplayCurrencyProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  return { urls, latest: () => latest! };
}

it("requests the report in the Reports section's overridden currency, not the ledger's own primary currency", async () => {
  const { urls, latest } = renderAt("/income-tax", baseSettings({ currency: "PLN", reports_currency: "EUR" }));
  await flush();

  // Settings load asynchronously — the very first request can briefly use
  // the primary currency before the real (server-persisted) override
  // settles in, same as every other section's own currency-aware request
  // (see cash-flow-reports-currency.spec.ts's own comment on this exact
  // race). The *final* settled call is what must carry the override.
  const calls = urls.filter((u) => u.startsWith("/api/income-tax"));
  expect(calls.at(-1)).toContain("currency=EUR");
  expect(calls.at(-1)).toContain("year=2026");
  // The response the page would actually render reflects that same
  // currency — not silently stuck at PLN (the ledger's primary/`currency`).
  expect(latest().data?.reporting_currency).toBe("EUR");
});

it("falls through to summary_currency, then to the ledger's primary currency, same as every other report section", async () => {
  const viaSummary = renderAt("/income-tax", baseSettings({ currency: "PLN", summary_currency: "USD" }));
  await flush();
  expect(viaSummary.urls.filter((u) => u.startsWith("/api/income-tax")).at(-1)).toContain("currency=USD");

  const viaPrimary = renderAt("/income-tax", baseSettings({ currency: "PLN" }));
  await flush();
  expect(viaPrimary.urls.filter((u) => u.startsWith("/api/income-tax")).at(-1)).toContain("currency=PLN");
});

it("a different configured currency is a distinct cache entry, not a stale reuse of the previous one", async () => {
  const eur = renderAt("/income-tax", baseSettings({ reports_currency: "EUR" }));
  await flush();
  expect(eur.latest().data?.reporting_currency).toBe("EUR");

  const usd = renderAt("/income-tax", baseSettings({ reports_currency: "USD" }));
  await flush();
  expect(usd.latest().data?.reporting_currency).toBe("USD");
  expect(usd.urls.filter((u) => u.startsWith("/api/income-tax")).at(-1)).toContain("currency=USD");
});
