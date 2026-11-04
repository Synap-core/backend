/**
 * Status / enum / priority SEMANTICS — what a stored status word MEANS, as a
 * tone name, never a colour.
 *
 * `getEnumTone` buckets a raw value ("won", "rejected", "in_progress") into a
 * small fixed tonal set. The word's tone is THE status tone table's
 * (`resolveStatusTone`, `@synap-core/types/units`), never a table of this
 * file's own: there used to be one here (`ENUM_TONE_MAP`) that painted
 * `rejected` / `cancelled` red and `draft` pending where every other surface
 * read them calm, so one status wore two colours across surfaces. A surface
 * maps the tone onto its own marks — app-bases onto `--synap-tone-*` tokens
 * (via `getEnumUnitTone`), pod-admin onto its `StatusPill` kinds — so the CSS
 * variables stay with the web skin and this module stays pure.
 *
 * Moved down from app-bases `headless/src/property-renderer/utils/
 * statusSemantics.ts` (its pure half; Wave 1 fork 1.1).
 */

import { resolveStatusTone, type UnitTone } from "../units/state.js";

/** The semantic tone of a status / enum value. */
export type EnumTone =
  "positive" | "negative" | "active" | "pending" | "neutral";

/** The enum bucket of each unit tone. */
const UNIT_TONE_ENUM: Readonly<Record<UnitTone, EnumTone>> = {
  success: "positive",
  error: "negative",
  primary: "active",
  info: "pending",
  warning: "pending",
  ai: "neutral",
  textSecondary: "neutral",
  textMuted: "neutral",
};

/** Which `UnitTone` (the cross-surface palette NAME) paints each enum tone. */
const ENUM_UNIT_TONE = {
  positive: "success",
  negative: "error",
  active: "primary",
  // teal: `--synap-info` and `--synap-secondary` are the same value in both modes
  pending: "info",
  neutral: "textMuted",
} as const satisfies Record<EnumTone, UnitTone>;

export function getEnumTone(value: string): EnumTone {
  return UNIT_TONE_ENUM[resolveStatusTone(value)];
}

/**
 * The tone NAME (a `UnitTone`) an enum/status value paints with. For hosts
 * that bind palette names to their own colours (relay's `useToneFill`, the
 * web's `--synap-tone-<tone>-*` tokens) and pure models that must carry a
 * tone, never a colour.
 */
export function getEnumUnitTone(value: string): UnitTone {
  return ENUM_UNIT_TONE[getEnumTone(value)];
}

// ─── Priority ────────────────────────────────────────────────────────────────

export type PriorityLevel = "urgent" | "high" | "medium" | "low" | "none";

/** Maps a raw priority string value to its level. */
export const PRIORITY_MAP: Record<string, PriorityLevel> = {
  urgent: "urgent",
  critical: "urgent",
  high: "high",
  medium: "medium",
  normal: "medium",
  low: "low",
  none: "none",
  no: "none",
};

/**
 * A stored priority is whatever the pod holds, typed or not: a number or a
 * boolean reaches this at runtime even though callers type it as a string.
 */
export function getPriorityLevel(value: unknown): PriorityLevel {
  return PRIORITY_MAP[String(value).trim().toLowerCase()] ?? "medium";
}
