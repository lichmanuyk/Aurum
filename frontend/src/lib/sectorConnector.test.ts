import { expect, it } from "vitest";
import { outerArcPoint, sectorMidAngleDeg } from "./sectorConnector";

it("splits unequal shares proportionally, with a padding gap only before the second sector", () => {
  // 70/30 split, paddingAngle=2 (SpendingByCategoryCard's own value): the
  // available 360° first loses 2 sectors × 2° = 4°, leaving 356° to split
  // 70/30, with a single 2° gap inserted before the second sector.
  const values = [70, 30];
  const mid0 = sectorMidAngleDeg(values, 0, 2);
  const mid1 = sectorMidAngleDeg(values, 1, 2);
  expect(mid0).not.toBeNull();
  expect(mid1).not.toBeNull();
  expect(mid0!).toBeCloseTo(0.7 * 356 / 2, 5); // 124.6
  expect(mid1!).toBeCloseTo(0.7 * 356 + 2 + (0.3 * 356) / 2, 5); // 304.6
});

it("centers a small sector near its own tiny arc, not thrown off by the much larger neighbor", () => {
  const values = [1, 999];
  const midSmall = sectorMidAngleDeg(values, 0, 2);
  const midLarge = sectorMidAngleDeg(values, 1, 2);
  expect(midSmall).not.toBeNull();
  expect(midLarge).not.toBeNull();
  // The tiny sector's own span is (1/1000)*356 ≈ 0.356°, centered at ≈0.178°.
  expect(midSmall!).toBeGreaterThan(0);
  expect(midSmall!).toBeLessThan(1);
  // The large sector takes up virtually the rest of the circle.
  expect(midLarge!).toBeGreaterThan(100);
  expect(midLarge!).toBeLessThan(260);
});

it("ignores paddingAngle entirely for a single sector, matching Recharts' own override", () => {
  // Recharts zeroes paddingAngle whenever displayedData.length <= 1,
  // regardless of what the caller passes in — a lone full-circle sector
  // must not lose any of its 360° to a "gap" it doesn't have a neighbor
  // to open next to.
  const mid = sectorMidAngleDeg([42], 0, 2);
  expect(mid).toBe(180);
});

it("returns null for an out-of-range index, a zero-value sector, or an all-zero chart", () => {
  expect(sectorMidAngleDeg([10, 20], -1, 2)).toBeNull();
  expect(sectorMidAngleDeg([10, 20], 5, 2)).toBeNull();
  expect(sectorMidAngleDeg([0, 20], 0, 2)).toBeNull();
  expect(sectorMidAngleDeg([0, 0], 0, 2)).toBeNull();
});

it("places the outer-arc point using Recharts' own margin-shrunk radius, not half the raw box", () => {
  // A 200×200 box: Recharts' default 5px chart margin on every side
  // shrinks the plotting area to 190×190, so the outer radius is 95, not
  // 100 — the point must land 5px short of the box's own edge.
  const right = outerArcPoint(0, 200, 200); // 0° = 3 o'clock
  expect(right.x).toBeCloseTo(195, 5);
  expect(right.y).toBeCloseTo(100, 5);

  const top = outerArcPoint(90, 200, 200); // 90° = 12 o'clock (clockwise-positive convention)
  expect(top.x).toBeCloseTo(100, 5);
  expect(top.y).toBeCloseTo(5, 5);

  const left = outerArcPoint(180, 200, 200);
  expect(left.x).toBeCloseTo(5, 5);
  expect(left.y).toBeCloseTo(100, 5);
});

it("uses the smaller dimension's margin-shrunk half as the radius on a non-square box", () => {
  const point = outerArcPoint(0, 300, 200); // narrower dimension (height) caps the radius
  expect(point.x).toBeCloseTo(150 + 95, 5); // center 150, radius min(290,190)/2=95
  expect(point.y).toBeCloseTo(100, 5);
});
