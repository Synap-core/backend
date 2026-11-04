/**
 * The words of a section's count, drawn after its title.
 *
 * Same rule as web `SpatialCount` and relay `RelayCount` (decision 488216a3,
 * "one count"): nothing until the count is measured and positive — a zero
 * says nothing a reader needs, the section's own empty state answers it —
 * and past 99 it reads "99+". A list size stays this quiet number. The soft
 * primary circle is only for a count that means "this needs you".
 */
import { formatFloorCount } from "@synap-core/types/value-format";

/** Above this a heading count reads "99+" (decision 488216a3). */
export const SECTION_COUNT_CAP = 99;

export function sectionCountLabel(
  count: number | null | undefined
): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || !(count > 0)) {
    return null;
  }
  const n = Math.floor(count);
  return n > SECTION_COUNT_CAP
    ? formatFloorCount(SECTION_COUNT_CAP, true)
    : formatFloorCount(n);
}
