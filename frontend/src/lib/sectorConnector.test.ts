import { expect, it } from "vitest";
import { buildDonutRoutePoints, outerArcPoint, sectorMidAngleDeg, segmentCrossesCircle, type Point } from "./sectorConnector";

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

const CENTER: Point = { x: 200, y: 200 };
const OUTER_RADIUS = 100;

it("segmentCrossesCircle: flags a chord straight through the center, clears a segment that stays well outside, and doesn't flag a radial approach that only touches the boundary at its own endpoint", () => {
  expect(segmentCrossesCircle({ x: 50, y: 200 }, { x: 350, y: 200 }, CENTER, OUTER_RADIUS)).toBe(true);
  expect(segmentCrossesCircle({ x: 400, y: 400 }, { x: 500, y: 500 }, CENTER, OUTER_RADIUS)).toBe(false);
  // A purely radial hop from just outside the circle in to the boundary
  // itself — exactly what the route's own final segment always is.
  expect(segmentCrossesCircle({ x: 320, y: 200 }, { x: 300, y: 200 }, CENTER, OUTER_RADIUS)).toBe(false);
});

it("routes every direction of the arc — a full sweep, from several different row heights — without any segment actually crossing the donut, and always with an equal first horizontal run landing exactly on the real outer arc", () => {
  // Rows at very different heights relative to the donut's own center:
  // near the middle, far above (near the top of a tall list), and far
  // below — the far-from-center cases are what would break a construction
  // that only accounted for a row roughly level with the donut.
  const rowAnchors: Point[] = [
    { x: 340, y: 200 }, // level with center
    { x: 340, y: 60 }, // far above
    { x: 340, y: 420 }, // far below
    { x: 340, y: 205 }, // just barely off-center
  ];

  for (const rowAnchor of rowAnchors) {
    for (let angle = 0; angle < 360; angle += 5) {
      const points = buildDonutRoutePoints(rowAnchor, CENTER, OUTER_RADIUS, angle);

      // Equal first horizontal run, every angle, every row height.
      expect(points[0]).toEqual(rowAnchor);
      expect(points[1].y).toBeCloseTo(rowAnchor.y, 5);
      expect(rowAnchor.x - points[1].x).toBeCloseTo(16, 5);

      // The endpoint lands exactly on the real outer arc, at this angle.
      const last = points[points.length - 1];
      const expectedTarget = {
        x: CENTER.x + Math.cos((-angle * Math.PI) / 180) * OUTER_RADIUS,
        y: CENTER.y + Math.sin((-angle * Math.PI) / 180) * OUTER_RADIUS,
      };
      expect(last.x).toBeCloseTo(expectedTarget.x, 5);
      expect(last.y).toBeCloseTo(expectedTarget.y, 5);

      // Every single segment of the actual constructed path — not just
      // its bounding box — stays clear of the donut itself.
      for (let i = 0; i < points.length - 1; i++) {
        expect(segmentCrossesCircle(points[i], points[i + 1], CENTER, OUTER_RADIUS)).toBe(false);
      }
    }
  }
});

it("takes the short, near-side path (no detour) when the target already faces the row's own side, and a longer around-the-donut path for the far side", () => {
  const rowAnchor: Point = { x: 340, y: 200 };
  // 0° = 3 o'clock, facing directly at the row — no detour needed.
  const near = buildDonutRoutePoints(rowAnchor, CENTER, OUTER_RADIUS, 0);
  expect(near).toHaveLength(4); // row, after-run, approach, target — one bend
  // 180° = 9 o'clock, the far side — must detour around top or bottom.
  const far = buildDonutRoutePoints(rowAnchor, CENTER, OUTER_RADIUS, 180);
  expect(far.length).toBeGreaterThan(4);
});
