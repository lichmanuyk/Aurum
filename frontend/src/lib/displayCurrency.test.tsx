import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DisplayCurrencyProvider,
  resolveConfiguredCurrency,
  useDisplayCurrencyAction,
  useSectionCurrency,
} from "./displayCurrency";
import { setCurrency } from "./i18n";
import type { AppSettings } from "@/types";

vi.mock("@/lib/auth", () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));

// React 19's act() otherwise warns "environment is not configured to
// support act" under plain jsdom (no @testing-library/react wiring it up).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEGACY_KEY = "aurum:summary-currency";
const MIGRATED_KEY = "aurum:summary-currency-migrated";

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
    app_version: "test",
    ...overrides,
  };
}

/** Serves GET/PATCH /api/settings from a shared mutable object, mirroring
 * the real route's PATCH-merges-into-the-singleton-row behavior — so a
 * mutation observed by the provider is reflected on its next GET, same as
 * the real backend. */
function mockSettingsApi(initial: AppSettings) {
  let current = initial;
  const patchCalls: Partial<AppSettings>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url !== "/api/settings") throw new Error(`Unexpected fetch: ${method} ${url}`);
    if (method === "PATCH") {
      const body = JSON.parse(init!.body as string) as Partial<AppSettings>;
      patchCalls.push(body);
      current = { ...current, ...body };
    }
    return new Response(JSON.stringify(current), { status: 200 });
  }));
  return { patchCalls, get current() { return current; } };
}

async function flush() {
  // Several macrotask turns, not one — react-query's fetch -> setQueryData
  // -> re-render pipeline can take more than a single tick to settle.
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = undefined;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("resolveConfiguredCurrency follows override > summary_currency > primary", () => {
  expect(resolveConfiguredCurrency(undefined, "PLN", "dashboard")).toBe("PLN");
  expect(resolveConfiguredCurrency(baseSettings(), "PLN", "dashboard")).toBe("PLN");
  expect(resolveConfiguredCurrency(baseSettings({ summary_currency: "USD" }), "PLN", "netWorth")).toBe("USD");
  expect(resolveConfiguredCurrency(
    baseSettings({ summary_currency: "USD", net_worth_currency: "EUR" }), "PLN", "netWorth"
  )).toBe("EUR");
  // An override on a different section never leaks into this one.
  expect(resolveConfiguredCurrency(
    baseSettings({ summary_currency: "USD", crypto_currency: "EUR" }), "PLN", "netWorth"
  )).toBe("USD");
});

interface Probe { currency: string; action: ReturnType<typeof useDisplayCurrencyAction>; }

function renderAt(path: string, settings: AppSettings) {
  // Mirrors App.tsx's own effect (setCurrency(settings.currency)) — in the
  // real app that's what makes useTranslation().currency reflect the
  // primary currency; this test exercises DisplayCurrencyProvider alone,
  // without mounting App.tsx.
  setCurrency(settings.currency);
  const api = mockSettingsApi(settings);
  const queryClient = new QueryClient();
  const latest: Probe = { currency: "", action: null };

  function Reader() {
    latest.currency = useSectionCurrency();
    latest.action = useDisplayCurrencyAction();
    return null;
  }

  const localRoot = createRoot(container);
  root = localRoot;
  act(() => {
    localRoot.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <DisplayCurrencyProvider><Reader /></DisplayCurrencyProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  return { api, latest };
}

it("Net Worth inherits summary_currency, and the header action toggles to primary without persisting", async () => {
  const { api, latest } = renderAt("/net-worth", baseSettings({ summary_currency: "USD" }));
  await flush();

  expect(latest.currency).toBe("USD");
  expect(latest.action?.configuredCurrency).toBe("USD");
  expect(latest.action?.primaryCurrency).toBe("PLN");
  expect(latest.action?.isTemporaryPrimaryView).toBe(false);

  act(() => latest.action!.toggle());
  expect(latest.currency).toBe("PLN");
  expect(latest.action?.isTemporaryPrimaryView).toBe(true);

  act(() => latest.action!.toggle());
  expect(latest.currency).toBe("USD");
  expect(latest.action?.isTemporaryPrimaryView).toBe(false);

  // The temporary view never PATCHes /settings — only reads happened.
  expect(api.patchCalls).toHaveLength(0);
});

it("an explicit per-page override wins over summary_currency", async () => {
  const { latest } = renderAt("/crypto", baseSettings({ summary_currency: "USD", crypto_currency: "EUR" }));
  await flush();
  expect(latest.currency).toBe("EUR");
});

it("shows no header action when the configured currency already matches primary", async () => {
  const { latest } = renderAt("/net-worth", baseSettings({ summary_currency: "PLN" }));
  await flush();
  expect(latest.action).toBeNull();
});

it("migrates the legacy localStorage choice once, only when the server has no explicit choice yet", async () => {
  localStorage.setItem(LEGACY_KEY, "EUR");
  const { api } = renderAt("/net-worth", baseSettings({ summary_currency: null }));
  await flush();

  expect(api.patchCalls).toEqual([{ summary_currency: "EUR" }]);
  expect(localStorage.getItem(MIGRATED_KEY)).toBe("1");
});

it("never overwrites an explicit server choice with the legacy local value", async () => {
  localStorage.setItem(LEGACY_KEY, "EUR");
  const { api } = renderAt("/net-worth", baseSettings({ summary_currency: "USD" }));
  await flush();

  expect(api.patchCalls).toHaveLength(0);
  expect(localStorage.getItem(MIGRATED_KEY)).toBe("1");
});

it("never migrates twice, even if the server is still unset on a later visit", async () => {
  localStorage.setItem(LEGACY_KEY, "EUR");
  localStorage.setItem(MIGRATED_KEY, "1");
  const { api } = renderAt("/net-worth", baseSettings({ summary_currency: null }));
  await flush();

  expect(api.patchCalls).toHaveLength(0);
});
