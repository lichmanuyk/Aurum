import { expect, it } from "vitest";
import { resolveDonutColors } from "./dashboardDonutColors";

it("keeps a category's own real color when nothing else on the donut shares it", () => {
  const resolved = resolveDonutColors([
    { key: "1", color: "#2a78d6" },
    { key: "2", color: "#eb6834" },
  ]);
  expect(resolved.get("1")).toBe("#2a78d6");
  expect(resolved.get("2")).toBe("#eb6834");
});

it("gives five same-colored categories five distinct solid fills — the first keeps the real color, the rest get distinct ramp slots", () => {
  const items = [
    { key: "1", color: "#2a78d6" },
    { key: "2", color: "#2a78d6" },
    { key: "3", color: "#2a78d6" },
    { key: "4", color: "#2a78d6" },
    { key: "5", color: "#2a78d6" },
  ];
  const resolved = resolveDonutColors(items);
  expect(resolved.get("1")).toBe("#2a78d6"); // lowest stable key wins the real color
  const fills = items.map((item) => resolved.get(item.key));
  expect(new Set(fills).size).toBe(5); // all five genuinely distinct
  // The collision-losers all borrow from the ramp, not a pattern/hatch —
  // "no hatching" per this task's own requirement.
  for (const key of ["2", "3", "4", "5"]) {
    expect(resolved.get(key)).toMatch(/^var\(--series-\d\)$/);
  }
});

it("resolves the maximum 8 sectors, including several simultaneous collisions, to 8 mutually distinct fills", () => {
  const items = [
    { key: "1", color: "#2a78d6" },
    { key: "2", color: "#2a78d6" },
    { key: "3", color: "#eb6834" },
    { key: "4", color: "#eb6834" },
    { key: "5", color: "#1baf7a" },
    { key: "6", color: "#eda100" },
    { key: "7", color: "#e87ba4" },
    { key: "other", color: "#898781" },
  ];
  const resolved = resolveDonutColors(items);
  const fills = items.map((item) => resolved.get(item.key));
  expect(new Set(fills).size).toBe(items.length);
});

it("stays stable when the array order changes (e.g. re-sorted by amount after a currency switch)", () => {
  const items = [
    { key: "1", color: "#2a78d6" },
    { key: "2", color: "#2a78d6" },
    { key: "3", color: "#eb6834" },
  ];
  const before = resolveDonutColors(items);
  const after = resolveDonutColors([...items].reverse());
  for (const item of items) {
    expect(after.get(item.key)).toBe(before.get(item.key));
  }
});

it("lets a real, unique color pass through 'Other' untouched, and gives up Other's own color first if a real category collides with it", () => {
  const noCollision = resolveDonutColors([
    { key: "1", color: "#2a78d6" },
    { key: "other", color: "#898781" },
  ]);
  expect(noCollision.get("other")).toBe("#898781");

  // A real category happens to pick exactly Other's reserved color —
  // "other" sorts last in the stable tie-break, so it's the one that gives
  // up the color, not the real (lower-id) category.
  const collision = resolveDonutColors([
    { key: "1", color: "#898781" },
    { key: "other", color: "#898781" },
  ]);
  expect(collision.get("1")).toBe("#898781");
  expect(collision.get("other")).not.toBe("#898781");
});

it("never reassigns a collision-loser to a ramp slot that exactly matches another category's own real color", () => {
  // #2a78d6 (blue) happens to be the ramp's own --series-1 value — a
  // naive "just pick the first unused ramp slot" would hand the loser
  // *back* the exact color it just lost, or hand it a color that lands
  // right on top of a third, unrelated category's real choice.
  const items = [
    { key: "1", color: "#2a78d6" }, // wins the real color
    { key: "2", color: "#2a78d6" }, // loses — must not become var(--series-1)
    { key: "3", color: "#eb6834" }, // real color that happens to equal --series-2
  ];
  const resolved = resolveDonutColors(items);
  expect(resolved.get("2")).not.toBe("var(--series-1)");
  expect(resolved.get("2")).not.toBe("var(--series-2)");
  const fills = items.map((item) => resolved.get(item.key));
  expect(new Set(fills).size).toBe(3);
});

it("returns the one real color unchanged for a single-sector donut, and an empty map for an empty one", () => {
  expect(resolveDonutColors([{ key: "1", color: "#2a78d6" }]).get("1")).toBe("#2a78d6");
  expect(resolveDonutColors([]).size).toBe(0);
});
