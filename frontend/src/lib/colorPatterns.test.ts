import { expect, it } from "vitest";
import { buildColorPatterns } from "./colorPatterns";

it("leaves a color's first occurrence plain and gives every later collision a distinct pattern", () => {
  const { fillFor, defs } = buildColorPatterns("test", [
    { key: "a", color: "#2a78d6" },
    { key: "b", color: "#2a78d6" },
    { key: "c", color: "#2a78d6" },
  ]);

  expect(fillFor("a")).toBe("#2a78d6");
  expect(fillFor("b")).toMatch(/^url\(#/);
  expect(fillFor("c")).toMatch(/^url\(#/);
  // Two different collisions of the same color must still tell apart from
  // each other, not just from the first plain occurrence.
  expect(fillFor("b")).not.toBe(fillFor("c"));
  expect(defs).not.toBeNull();
});

it("leaves every item plain when no two items share a color", () => {
  const { fillFor, defs } = buildColorPatterns("test", [
    { key: "a", color: "#2a78d6" },
    { key: "b", color: "#eb6834" },
  ]);

  expect(fillFor("a")).toBe("#2a78d6");
  expect(fillFor("b")).toBe("#eb6834");
  expect(defs).toBeNull();
});

it("only patterns the colliding color, leaving an unrelated unique color untouched", () => {
  const { fillFor } = buildColorPatterns("test", [
    { key: "a", color: "#2a78d6" },
    { key: "b", color: "#2a78d6" },
    { key: "c", color: "#eb6834" },
  ]);

  expect(fillFor("a")).toBe("#2a78d6");
  expect(fillFor("b")).toMatch(/^url\(#/);
  expect(fillFor("c")).toBe("#eb6834");
});
