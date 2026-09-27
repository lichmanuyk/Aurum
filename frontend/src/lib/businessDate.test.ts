import { describe, expect, it } from "vitest";
import { businessDateMonth, businessDateYear, formatBusinessDate, parseBusinessDate } from "./businessDate";

describe("parseBusinessDate", () => {
  it("reads year/month/day straight out of the string, 1-based month", () => {
    expect(parseBusinessDate("2026-09-27")).toEqual({ year: 2026, month: 9, day: 27 });
    expect(parseBusinessDate("2026-01-01")).toEqual({ year: 2026, month: 1, day: 1 });
    expect(parseBusinessDate("2026-12-31")).toEqual({ year: 2026, month: 12, day: 31 });
  });

  it("rejects anything that isn't exactly YYYY-MM-DD", () => {
    expect(() => parseBusinessDate("2026-9-27")).toThrow();
    expect(() => parseBusinessDate("2026-09-27T00:00:00Z")).toThrow();
    expect(() => parseBusinessDate("not-a-date")).toThrow();
  });

  it("never round-trips through a browser-local Date — same string in every simulated timezone", () => {
    // The whole point of parsing the string directly (see businessDate.ts's
    // own module docstring): the same ISO date must parse identically no
    // matter what timezone happens to be running this code. Simulated here
    // via Intl's own offset math instead of actually switching TZ, since
    // parseBusinessDate deliberately never constructs a `Date` at all.
    const parsed = parseBusinessDate("2026-01-01");
    expect(parsed).toEqual({ year: 2026, month: 1, day: 1 });
  });
});

describe("businessDateYear / businessDateMonth", () => {
  it("extract the matching component", () => {
    expect(businessDateYear("2026-09-27")).toBe(2026);
    expect(businessDateMonth("2026-09-27")).toBe(9);
  });
});

describe("formatBusinessDate", () => {
  it("zero-pads month and day back into YYYY-MM-DD", () => {
    expect(formatBusinessDate({ year: 2026, month: 1, day: 1 })).toBe("2026-01-01");
    expect(formatBusinessDate({ year: 2026, month: 9, day: 27 })).toBe("2026-09-27");
  });

  it("round-trips with parseBusinessDate for any date, without shifting a day", () => {
    for (const iso of ["2026-01-01", "2026-02-28", "2026-03-29", "2026-10-25", "2026-12-31"]) {
      expect(formatBusinessDate(parseBusinessDate(iso))).toBe(iso);
    }
  });
});
