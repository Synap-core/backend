/**
 * A stored status word → the console's ONE pill.
 *
 * The meaning comes from `@synap-core/types/property-render` (`getEnumTone`,
 * the same rule app-bases chips paint from); the words come from the
 * vocabulary (`resolveStatusLabel`). This file only maps the semantic tone
 * onto `StatusPill`'s four kinds — never a second status table.
 */

import { getEnumTone, type EnumTone } from "@synap-core/types/property-render";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../(admin)/components/status-pill";

/**
 * `active` is healthy on purpose: for the objects the console shows (a rule
 * that is on, a session in motion) "running" is the good state. `pending`
 * reads amber — awaiting a look — which is what `stale` means on the pill.
 */
const PILL_KIND: Record<EnumTone, StatusKind> = {
  positive: "healthy",
  active: "healthy",
  pending: "stale",
  negative: "down",
  neutral: "unknown",
};

export function statusKindForTone(tone: EnumTone): StatusKind {
  return PILL_KIND[tone];
}

/** Pill props for a raw status value, or null when there is none to show. */
export function statusPillFor(
  value: string | null | undefined
): { kind: StatusKind; label: string } | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  return {
    kind: statusKindForTone(getEnumTone(raw)),
    label: resolveStatusLabel(raw),
  };
}
