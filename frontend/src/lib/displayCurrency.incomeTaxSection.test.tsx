/** Regression coverage for one specific fix: Income & Taxes (/income-tax)
 * joining the existing "reports" section in lib/displayCurrency.tsx's
 * SECTIONS table, rather than getting a dedicated AppSettings column of
 * its own — see docs/tasks/income-tax-separation.md and the independent
 * frontend review that found this page was previously stuck permanently
 * in the ledger's own raw currency (no section at all). Deliberately a
 * separate file from lib/displayCurrency.test.tsx (that one is owned by
 * the main implementation pass) — this one only exercises the one new
 * path, through the same public API every other section already uses.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DisplayCurrencyProvider, useDisplayCurrencyAction, useSectionCurrency } from "./displayCurrency";
import { setCurrency } from "./i18n";
import type { AppSettings } from "@/types";

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

interface Probe { currency: string; action: ReturnType<typeof useDisplayCurrencyAction>; }

function renderAt(path: string, settings: AppSettings) {
  setCurrency(settings.currency);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url !== "/api/settings") throw new Error(`Unexpected fetch in this test: ${url}`);
    return new Response(JSON.stringify(settings), { status: 200 });
  }));
  const queryClient = new QueryClient();
  const latest: Probe = { currency: "", action: null };
  function Reader() {
    latest.currency = useSectionCurrency();
    latest.action = useDisplayCurrencyAction();
    return null;
  }
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <DisplayCurrencyProvider><Reader /></DisplayCurrencyProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  return latest;
}

it("Income & Taxes (/income-tax) inherits the Reports section's own override, not just summary_currency", async () => {
  const latest = renderAt("/income-tax", baseSettings({ currency: "PLN", summary_currency: "USD", reports_currency: "EUR" }));
  await flush();
  // Same value a /reports request would resolve to for this same settings
  // row — proving /income-tax now shares that section rather than falling
  // through to the ledger's own primary currency (the pre-fix behavior).
  expect(latest.currency).toBe("EUR");
  expect(latest.action?.configuredCurrency).toBe("EUR");
});

it("Income & Taxes falls through to summary_currency when Reports has no override of its own", async () => {
  const latest = renderAt("/income-tax", baseSettings({ currency: "PLN", summary_currency: "USD" }));
  await flush();
  expect(latest.currency).toBe("USD");
});

it("the Topbar's compact currency toggle appears on /income-tax whenever the configured currency differs from primary", async () => {
  const configured = renderAt("/income-tax", baseSettings({ currency: "PLN", reports_currency: "EUR" }));
  await flush();
  expect(configured.action).not.toBeNull();
  expect(configured.action?.primaryCurrency).toBe("PLN");

  const matching = renderAt("/income-tax", baseSettings({ currency: "PLN", reports_currency: "PLN" }));
  await flush();
  expect(matching.action).toBeNull();
});
