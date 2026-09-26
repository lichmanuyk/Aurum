/** When two or more items in the same donut share an identical category
 * color, "различимость секторов" (see docs/tasks/donut-chart-interaction.md)
 * has to hold at rest, before any hover ever happens — the synchronized
 * highlight alone only kicks in on interaction. Every item past the first
 * occurrence of a color gets a distinguishing overlay pattern baked into its
 * own SVG <pattern>; the base color itself is untouched (no new colors
 * written anywhere — existing category colors only), and colors that don't
 * collide with anything stay a plain, undecorated fill. */
import { Fragment, type ReactNode } from "react";

export interface PatternedItem {
  key: string;
  color: string;
}

interface PatternRecipe {
  width: number;
  height: number;
  patternTransform?: string;
  content: ReactNode;
}

// Twelve genuinely distinct tile shapes (not just a handful cycling) —
// varying shape *and* rotation *and* tile size/spacing, not just stripe
// thickness, so consecutive collisions actually look different from each
// other. The dashboard donut folds anything past MAX_CHART_SLICES (8, see
// dashboard_service.py) into "Other", so 12 recipes cover every category the
// chart can ever show sharing one color with room to spare — cycling only
// past a 13th same-colored item, an already-impossible case.
const RECIPES: PatternRecipe[] = [
  { width: 6, height: 6, patternTransform: "rotate(45)", content: <rect x={0} y={0} width={3} height={6} fill="rgba(255,255,255,0.55)" /> }, // diagonal stripe ╱
  { width: 6, height: 6, patternTransform: "rotate(-45)", content: <rect x={0} y={0} width={3} height={6} fill="rgba(255,255,255,0.55)" /> }, // diagonal stripe ╲
  { width: 6, height: 6, content: <circle cx={3} cy={3} r={1.4} fill="rgba(0,0,0,0.4)" /> }, // small dots
  {
    width: 6,
    height: 6,
    content: (
      <Fragment>
        <rect x={0} y={0} width={6} height={1.4} fill="rgba(0,0,0,0.35)" />
        <rect x={0} y={0} width={1.4} height={6} fill="rgba(0,0,0,0.35)" />
      </Fragment>
    ),
  }, // crosshatch
  { width: 6, height: 6, content: <rect x={0} y={0} width={6} height={2.4} fill="rgba(255,255,255,0.55)" /> }, // horizontal band
  { width: 6, height: 6, content: <rect x={0} y={0} width={2.4} height={6} fill="rgba(255,255,255,0.55)" /> }, // vertical band
  { width: 9, height: 9, content: <circle cx={4.5} cy={4.5} r={2.4} fill="rgba(0,0,0,0.4)" /> }, // large, widely-spaced dots
  { width: 4, height: 4, content: <circle cx={2} cy={2} r={0.9} fill="rgba(0,0,0,0.45)" /> }, // small, dense dots
  { width: 8, height: 8, patternTransform: "rotate(45)", content: <rect x={0} y={0} width={5} height={8} fill="rgba(255,255,255,0.5)" /> }, // thick diagonal band
  {
    width: 8,
    height: 8,
    patternTransform: "rotate(45)",
    content: (
      <Fragment>
        <rect x={0} y={0} width={1.4} height={8} fill="rgba(255,255,255,0.6)" />
        <rect x={4} y={0} width={1.4} height={8} fill="rgba(255,255,255,0.6)" />
      </Fragment>
    ),
  }, // double thin diagonal stripes
  {
    width: 8,
    height: 8,
    content: (
      <Fragment>
        <rect x={0} y={0} width={4} height={4} fill="rgba(0,0,0,0.3)" />
        <rect x={4} y={4} width={4} height={4} fill="rgba(0,0,0,0.3)" />
      </Fragment>
    ),
  }, // checkerboard
  { width: 4, height: 4, patternTransform: "rotate(45)", content: <rect x={0} y={0} width={1.2} height={4} fill="rgba(255,255,255,0.55)" /> }, // fine dense diagonal stripe
];

/** Assigns each item a fill: its own color for a color's first occurrence,
 * or `url(#...)` pointing at a pattern layering a neutral overlay on top of
 * that same color for every occurrence after the first. Assigning by
 * *order of appearance per color* (not by index) is what keeps two
 * colliding categories consistently distinguishable from each other
 * specifically, not just from everything else on the chart. `defs` renders
 * the actual <pattern> elements — mount it once anywhere in the same
 * document as whatever reads `fillFor` (SVG `url(#id)` references resolve
 * document-wide, not just within one <svg> subtree), and it's `null` when
 * nothing on this chart actually collides. */
export function buildColorPatterns(prefix: string, items: readonly PatternedItem[]): { fillFor: (key: string) => string; defs: ReactNode } {
  const seen = new Map<string, number>();
  const fillByKey = new Map<string, string>();
  const neededDefs: Array<{ id: string; color: string; recipeIndex: number }> = [];

  for (const item of items) {
    const occurrence = seen.get(item.color) ?? 0;
    seen.set(item.color, occurrence + 1);
    if (occurrence === 0) {
      fillByKey.set(item.key, item.color);
    } else {
      const id = `${prefix}-pattern-${item.key}`;
      fillByKey.set(item.key, `url(#${id})`);
      neededDefs.push({ id, color: item.color, recipeIndex: (occurrence - 1) % RECIPES.length });
    }
  }

  const fillFor = (key: string): string => fillByKey.get(key) ?? "currentColor";
  const defs =
    neededDefs.length === 0 ? null : (
      <svg width={0} height={0} aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          {neededDefs.map(({ id, color, recipeIndex }) => {
            const recipe = RECIPES[recipeIndex];
            return (
              <pattern key={id} id={id} width={recipe.width} height={recipe.height} patternUnits="userSpaceOnUse" patternTransform={recipe.patternTransform}>
                <rect width={recipe.width} height={recipe.height} fill={color} />
                {recipe.content}
              </pattern>
            );
          })}
        </defs>
      </svg>
    );

  return { fillFor, defs };
}
