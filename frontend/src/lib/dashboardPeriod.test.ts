import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dashboardLinkFor, parseDashboardPeriodParams, visibleMonthCount } from "./dashboardPeriod";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

it("builds an all-time link with no year/month, a whole-year link with no month, and a specific-month link unchanged", () => {
  expect(dashboardLinkFor({ year: null, month: null })).toBe("/transactions?period=all");
  expect(dashboardLinkFor({ year: 2024, month: null })).toBe("/transactions?year=2024");
  expect(dashboardLinkFor({ year: 2018, month: 3 })).toBe("/transactions?year=2018&month=3");
});

it("parses ?period=all as all time regardless of any year/month also present", () => {
  expect(parseDashboardPeriodParams(new URLSearchParams("period=all"), { year: 2020, month: 1 })).toEqual({
    year: null, month: null,
  });
  expect(parseDashboardPeriodParams(new URLSearchParams("period=all&year=2018&month=3"), { year: 2020, month: 1 })).toEqual({
    year: null, month: null,
  });
});

it("parses year-without-month (or month=all) as every month of that year", () => {
  expect(parseDashboardPeriodParams(new URLSearchParams("year=2024"), { year: 2020, month: 1 })).toEqual({
    year: 2024, month: null,
  });
  expect(parseDashboardPeriodParams(new URLSearchParams("year=2024&month=all"), { year: 2020, month: 1 })).toEqual({
    year: 2024, month: null,
  });
});

it("parses year+month exactly as before — the old dashboard-to-transactions-deeplink contract", () => {
  expect(parseDashboardPeriodParams(new URLSearchParams("year=2018&month=3"), { year: 2020, month: 1 })).toEqual({
    year: 2018, month: 3,
  });
});

it("falls back to the given default when there are no params at all — a bare /transactions from the nav sidebar", () => {
  expect(parseDashboardPeriodParams(new URLSearchParams(""), { year: 2020, month: 1 })).toEqual({
    year: 2020, month: 1,
  });
});

it("falls back on an invalid month instead of silently landing on a wrong one", () => {
  expect(parseDashboardPeriodParams(new URLSearchParams("year=2024&month=13"), { year: 2020, month: 1 })).toEqual({
    year: 2024, month: null,
  });
  expect(parseDashboardPeriodParams(new URLSearchParams("year=2024&month=bogus"), { year: 2020, month: 1 })).toEqual({
    year: 2024, month: null,
  });
});

it("visibleMonthCount stops at the current month for the current year, and is 12 for any other year", () => {
  expect(visibleMonthCount(2026)).toBe(9); // "today" is faked to 2026-09-25 above
  expect(visibleMonthCount(2025)).toBe(12);
  expect(visibleMonthCount(2030)).toBe(12);
});
