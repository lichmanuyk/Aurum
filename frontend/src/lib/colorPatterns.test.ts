import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildColorPatterns } from "./colorPatterns";

/** The actual rendered <pattern id="..."> markup for one item's fill, with
 * the id attribute stripped — so two items can be compared on what their
 * tile actually looks like (shape/size/rotation), not on the id string
 * alone (which is always unique per item by construction, even if the
 * *visual* recipe behind it were buggily reused). */
function patternMarkup(defsNode: ReturnType<typeof buildColorPatterns>["defs"], fill: string): string {
  const id = fill.match(/^url\(#(.+)\)$/)?.[1];
  expect(id, `expected a pattern url(), got "${fill}"`).toBeTruthy();
  const markup = renderToStaticMarkup(defsNode);
  const match = markup.match(new RegExp(`<pattern id="${id}"[^]*?</pattern>`));
  expect(match, `no <pattern id="${id}"> found in defs markup`).toBeTruthy();
  return match![0].replace(`id="${id}"`, "");
}

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

it("gives at least five same-colored categories genuinely distinct pattern tiles, not just distinct ids", () => {
  const items = ["a", "b", "c", "d", "e"].map((key) => ({ key, color: "#2a78d6" }));
  const { fillFor, defs } = buildColorPatterns("test", items);

  // "a" is the color's first occurrence and stays the plain color; "b"
  // through "e" (four collisions) each need their own actual tile.
  const signatures = items.slice(1).map((item) => patternMarkup(defs, fillFor(item.key)));
  expect(new Set(signatures).size).toBe(signatures.length);
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
