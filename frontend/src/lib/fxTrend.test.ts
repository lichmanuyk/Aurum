import { expect, it } from "vitest";
import { computeTrend } from "./fxTrend";

const point = (value: string | null) => ({ date: "2026-01-01", value });

it("is green (up) when the last value ended above the first", () => {
  expect(computeTrend([point("1"), point("2"), point("1.5")])).toBe("up");
});

it("is red (down) when the last value ended below the first", () => {
  expect(computeTrend([point("2"), point("1.5"), point("1")])).toBe("down");
});

it("is neutral when the first and last unrounded values are equal", () => {
  expect(computeTrend([point("1.00001"), point("9"), point("1.00001")])).toBe("neutral");
});

it("is neutral for a single point", () => {
  expect(computeTrend([point("1")])).toBe("neutral");
});

it("is neutral for an empty series", () => {
  expect(computeTrend([])).toBe("neutral");
});

it("is neutral for any series with a gap, even if it would otherwise trend up", () => {
  // A partial series' first/last *available* points are arbitrary internal
  // ones, not the period's true edges — never colour by them.
  expect(computeTrend([point("1"), point(null), point("2")])).toBe("neutral");
  expect(computeTrend([point(null), point("1"), point("2")])).toBe("neutral");
  expect(computeTrend([point("1"), point("2"), point(null)])).toBe("neutral");
});
