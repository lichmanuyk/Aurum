import { useCallback, useLayoutEffect, useState } from "react";

/** Shared hover/pin state for a donut/bar ↔ list pair (see
 * docs/tasks/donut-chart-interaction.md,
 * docs/tasks/capital-allocation-interaction.md) — reused identically by
 * SpendingByCategoryCard, CryptoAllocationBody, CryptoNetworkAllocationBody
 * and AssetAllocationCard rather than each reimplementing it.
 *
 * Hover and keyboard focus behave the same way (both just move
 * `hoveredId`) and revert the moment the pointer/focus leaves. A click (or
 * a phone tap, which fires as a click) *pins* the id instead — it survives
 * the pointer leaving, and is the only thing a phone user gets since touch
 * has no real hover. Pinning the same id again, or Escape, un-pins.
 * `activeId` is what should actually be highlighted right now: a live
 * hover always wins over a pin, so briefly hovering something else while a
 * pin is active still previews it correctly.
 *
 * `validIds` is the caller's current id set (categories/classes/coins —
 * whatever this render's rows/sectors actually are). A pinned/hovered id
 * can outlive the row it pointed at — a currency, period, or holdings
 * refresh can drop or rename items out from under it. This clears the
 * *actual state*, not just what's displayed for one render: if the same
 * key ever comes back later (e.g. a class that briefly had zero balance),
 * it comes back unselected, not silently reactivated from state that was
 * merely hidden in the meantime. */
export function useChartSelection<Id extends string>(validIds: ReadonlySet<Id>) {
  const [hoveredId, setHoveredId] = useState<Id | null>(null);
  const [pinnedId, setPinnedId] = useState<Id | null>(null);

  // A layout effect, not a passive one — it must land before the next
  // paint (and, just as importantly, before a synchronous re-render can
  // observe stale state), or a currency/data refresh could briefly flash
  // a highlight on whatever now occupies the old id, or — in code that
  // re-renders synchronously in response to its own state — see the old
  // id survive a tick it shouldn't.
  useLayoutEffect(() => {
    setHoveredId((current) => (current !== null && !validIds.has(current) ? null : current));
    setPinnedId((current) => (current !== null && !validIds.has(current) ? null : current));
  }, [validIds]);

  const enter = useCallback((id: Id) => setHoveredId(id), []);
  const leave = useCallback(() => setHoveredId(null), []);
  // Clearing hoveredId here too (not just pinnedId) matters specifically for
  // touch: tapping a row also focuses it (onFocus sets hoveredId, same as a
  // real hover), but touch has no pointer to later "leave" from — there's no
  // mouseleave/blur coming to ever clear it again. Without this, a second
  // tap would correctly clear the pin yet the row would stay lit forever
  // from that stuck hover. On a mouse, this is harmless: pinnedId alone
  // already drives the highlight right after a click either way.
  const togglePin = useCallback((id: Id) => {
    setHoveredId(null);
    setPinnedId((current) => (current === id ? null : id));
  }, []);
  const clearPin = useCallback(() => setPinnedId(null), []);
  const onKeyDown = useCallback(
    (event: { key: string; preventDefault: () => void }, id: Id) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        togglePin(id);
      } else if (event.key === "Escape") {
        clearPin();
      }
    },
    [togglePin, clearPin]
  );

  return { activeId: hoveredId ?? pinnedId, pinnedId, enter, leave, togglePin, clearPin, onKeyDown };
}
