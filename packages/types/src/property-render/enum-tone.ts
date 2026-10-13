/**
 * Status / enum / priority SEMANTICS — what a stored status word MEANS, as a
 * tone name, never a colour.
 *
 * `getEnumTone` buckets a raw value ("won", "rejected", "in_progress") into a
 * small fixed tonal set so a family always reads the same: same-family values
 * resolve to the same tone, no per-string hashing, no hex palette. A surface
 * maps the tone onto its own marks — app-bases onto `--synap-tone-*` tokens
 * (via `getEnumUnitTone`), pod-admin onto its `StatusPill` kinds — so the CSS
 * variables stay with the web skin and this module stays pure.
 *
 * HOME: here (`@synap-core/types/property-render`), moved down from app-bases
 * `@synap-core/headless/property-renderer/utils/statusSemantics.ts` (the pure
 * half: `ENUM_TONE_TOKEN` / `ENUM_TONE_INK` / `getEnumColor` / `getEnumInk`
 * wrap these tones in web tokens and stay there, as does the web StatusPill's
 * own `STATUS_PILL_MAP`). Follow-up: re-point that file's tone and priority
 * functions here.
 */

import type { UnitTone } from "../units/state.js";

/** The semantic tone of a status / enum value. */
export type EnumTone =
  "positive" | "negative" | "active" | "pending" | "neutral";

/** Maps a raw enum/status string to a semantic tone bucket. */
const ENUM_TONE_MAP: Record<string, EnumTone> = {
  // positive / success
  completed: "positive",
  done: "positive",
  won: "positive",
  approved: "positive",
  accepted: "positive",
  published: "positive",
  success: "positive",
  enabled: "positive",
  // negative / error
  blocked: "negative",
  rejected: "negative",
  failed: "negative",
  error: "negative",
  lost: "negative",
  cancelled: "negative",
  canceled: "negative",
  unqualified: "negative",
  // active / in motion
  active: "active",
  open: "active",
  "in-progress": "active",
  "in progress": "active",
  in_progress: "active",
  contacted: "active",
  qualified: "active",
  negotiation: "active",
  running: "active",
  // pending / waiting
  pending: "pending",
  draft: "pending",
  "in-review": "pending",
  "in review": "pending",
  review: "pending",
  todo: "pending",
  proposed: "pending",
  new: "pending",
  lead: "pending",
  scheduled: "pending",
  forming: "pending",
  stale: "pending",
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
  const normalized = value.toLowerCase().replace(/\s+/g, "-");
  return (
    ENUM_TONE_MAP[normalized] ?? ENUM_TONE_MAP[value.toLowerCase()] ?? "neutral"
  );
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

export function getPriorityLevel(value: string): PriorityLevel {
  return PRIORITY_MAP[value.toLowerCase()] ?? "medium";
}
