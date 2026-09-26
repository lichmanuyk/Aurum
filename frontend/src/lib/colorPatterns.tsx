/** When two or more items in the same donut share an identical category
 * color, "различимость секторов" (see docs/tasks/donut-chart-interaction.md)
 * has to hold at rest, before any hover ever happens — the synchronized
 * highlight alone only kicks in on interaction. Every item past the first
 * occurrence of a color gets a distinguishing overlay pattern baked into its
 * own SVG <pattern>, cycling through a few neutral overlay kinds; the base
 * color itself is untouched (no new colors written anywhere — existing
 * category colors only), and colors that don't collide with anything stay a
 * plain, undecorated fill. */
import { Fragment, type ReactNode } from "react";

export interface PatternedItem {
  key: string;
  color: string;
}

const OVERLAY_KIND_COUNT = 3;

function overlayShape(kind: number) {
  switch (((kind - 1) % OVERLAY_KIND_COUNT) + 1) {
    case 1: // diagonal stripe
      return <rect x={0} y={0} width={3} height={6} fill="rgba(255,255,255,0.55)" />;
    case 2: // dot
      return <circle cx={3} cy={3} r={1.4} fill="rgba(0,0,0,0.4)" />;
    default: // crosshatch
      return (
        <Fragment>
          <rect x={0} y={0} width={6} height={1.4} fill="rgba(0,0,0,0.35)" />
          <rect x={0} y={0} width={1.4} height={6} fill="rgba(0,0,0,0.35)" />
        </Fragment>
      );
  }
}

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
  const neededDefs: Array<{ id: string; color: string; kind: number }> = [];

  for (const item of items) {
    const occurrence = seen.get(item.color) ?? 0;
    seen.set(item.color, occurrence + 1);
    if (occurrence === 0) {
      fillByKey.set(item.key, item.color);
    } else {
      const id = `${prefix}-pattern-${item.key}`;
      fillByKey.set(item.key, `url(#${id})`);
      neededDefs.push({ id, color: item.color, kind: occurrence });
    }
  }

  const fillFor = (key: string): string => fillByKey.get(key) ?? "currentColor";
  const defs =
    neededDefs.length === 0 ? null : (
      <svg width={0} height={0} aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          {neededDefs.map(({ id, color, kind }) => (
            <pattern key={id} id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill={color} />
              {overlayShape(kind)}
            </pattern>
          ))}
        </defs>
      </svg>
    );

  return { fillFor, defs };
}
