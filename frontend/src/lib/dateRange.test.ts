import { describe, expect, it } from "vitest";
import { computeRange } from "./dateRange";

describe("computeRange", () => {
  it("'all' is always ready, with no bound, and never needs a business date", () => {
    expect(computeRange("all", undefined)).toEqual({ status: "ready" });
    expect(computeRange("all", "2026-09-27")).toEqual({ status: "ready" });
  });

  it("'this_year' spans Jan 1 of the business date's year through the business date itself", () => {
    expect(computeRange("this_year", "2026-09-27")).toEqual({
      status: "ready", startDate: "2026-01-01", endDate: "2026-09-27",
    });
  });

  it("'5y' starts on the 1st of the business date's month, 5 years back, through the business date itself", () => {
    expect(computeRange("5y", "2026-09-27")).toEqual({
      status: "ready", startDate: "2021-09-01", endDate: "2026-09-27",
    });
  });

  it("'custom' uses the given years verbatim and never needs a business date", () => {
    expect(computeRange("custom", undefined, { fromYear: 2018, toYear: 2020 })).toEqual({
      status: "ready", startDate: "2018-01-01", endDate: "2020-12-31",
    });
    expect(computeRange("custom", undefined)).toEqual({ status: "ready" });
  });

  it("'this_year'/'5y' are 'pending' — never a guessed date, never silently 'all' — while the business date hasn't loaded yet", () => {
    expect(computeRange("this_year", undefined)).toEqual({ status: "pending" });
    expect(computeRange("5y", undefined)).toEqual({ status: "pending" });
  });

  it("never shifts a day regardless of which calendar boundary the business date sits on", () => {
    expect(computeRange("this_year", "2026-01-01")).toEqual({
      status: "ready", startDate: "2026-01-01", endDate: "2026-01-01",
    });
    expect(computeRange("this_year", "2026-12-31")).toEqual({
      status: "ready", startDate: "2026-01-01", endDate: "2026-12-31",
    });
  });
});
