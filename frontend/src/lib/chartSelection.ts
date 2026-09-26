import { useCallback, useState } from "react";

/** Shared hover/pin state for a donut ↔ list pair (see
 * docs/tasks/donut-chart-interaction.md) — reused identically by
 * SpendingByCategoryCard, CryptoAllocationBody and
 * CryptoNetworkAllocationBody rather than each reimplementing it.
 *
 * Hover and keyboard focus behave the same way (both just move
 * `hoveredId`) and revert the moment the pointer/focus leaves. A click (or
 * a phone tap, which fires as a click) *pins* the id instead — it survives
 * the pointer leaving, and is the only thing a phone user gets since touch
 * has no real hover. Pinning the same id again, or Escape, un-pins.
 * `activeId` is what should actually be highlighted right now: a live
 * hover always wins over a pin, so briefly hovering something else while a
 * pin is active still previews it correctly. */
export function useChartSelection<Id extends string>() {
  const [hoveredId, setHoveredId] = useState<Id | null>(null);
  const [pinnedId, setPinnedId] = useState<Id | null>(null);

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

/** A pinned/hovered id can outlive the row it pointed at — a currency,
 * period, or holdings refresh can drop or rename items out from under it.
 * Filtering it against the *current* id set at read time (rather than an
 * effect that clears it later) means a stale id simply never highlights or
 * opens anything for a tick, with nothing left to clean up. */
export function liveId<Id extends string>(id: Id | null, validIds: ReadonlySet<Id>): Id | null {
  return id !== null && validIds.has(id) ? id : null;
}
