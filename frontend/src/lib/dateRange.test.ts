import { expect, it } from "vitest";
import { parseRangeParam, parseYearRangeParam, reportsLinkFor } from "./dateRange";

it("builds a reports link carrying the category and preset range, without year params for a non-custom preset", () => {
  expect(reportsLinkFor(42, "this_year", { fromYear: 2020, toYear: 2020 })).toBe(
    "/reports?category_id=42&range=this_year"
  );
});

it("builds a reports link carrying from_year/to_year only for the custom preset", () => {
  expect(reportsLinkFor(42, "custom", { fromYear: 2018, toYear: 2021 })).toBe(
    "/reports?category_id=42&range=custom&from_year=2018&to_year=2021"
  );
});

it("parses a valid range param and falls back for anything else, same as TransactionsPage's year/month parsing", () => {
  expect(parseRangeParam("5y", "all")).toBe("5y");
  expect(parseRangeParam("bogus", "all")).toBe("all");
  expect(parseRangeParam(null, "this_year")).toBe("this_year");
});

it("parses a valid positive-integer year param and falls back otherwise", () => {
  expect(parseYearRangeParam("2019", 2024)).toBe(2019);
  expect(parseYearRangeParam("not-a-year", 2024)).toBe(2024);
  expect(parseYearRangeParam("-5", 2024)).toBe(2024);
  expect(parseYearRangeParam(null, 2024)).toBe(2024);
});
