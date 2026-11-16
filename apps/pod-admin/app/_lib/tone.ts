/**
 * THE tone token (`UnitTone`, `@synap-core/types/units`) → this app's
 * classes. The tone is decided once, in the shared contract (a unit's state
 * `resolveUnitState`, a risk `needsYouRisk`, an ask's age and fate
 * `askCardView`, a trust-ladder outcome); this file only says how pod-admin's
 * palette draws it — one map, so a "warning" reads the same on every page.
 *
 * It replaced the hand tables that drew the same tokens three ways: the
 * proposal review's `MARK_TONE`, the ask detail's `TONE_TEXT` and the
 * governance pages' `mark-tone.ts` (which now re-exports this).
 */
import type { UnitTone } from "@synap-core/types/units";

const TONE_TEXT: Record<UnitTone, string> = {
  success: "text-status-healthy",
  warning: "text-status-stale",
  error: "text-status-down",
  info: "text-primary",
  primary: "text-primary",
  ai: "text-primary",
  textSecondary: "text-foreground/70",
  textMuted: "text-foreground/45",
};

/** A filled mark (a chip, a state tile): its ground, ink and edge. */
const TONE_MARK: Record<UnitTone, string> = {
  success: "bg-status-healthy/10 text-status-healthy ring-status-healthy/25",
  warning: "bg-status-stale/10 text-status-stale ring-status-stale/25",
  error: "bg-status-down/10 text-status-down ring-status-down/25",
  info: "bg-primary/10 text-primary ring-primary/25",
  primary: "bg-primary/10 text-primary ring-primary/25",
  ai: "bg-primary/10 text-primary ring-primary/25",
  textSecondary: "bg-foreground/[0.05] text-foreground/75 ring-foreground/15",
  textMuted: "bg-foreground/[0.03] text-foreground/55 ring-foreground/10",
};

/** A dot or a rail: the tone as a solid fill. */
const TONE_FILL: Record<UnitTone, string> = {
  success: "bg-status-healthy",
  warning: "bg-status-stale",
  error: "bg-status-down",
  info: "bg-primary",
  primary: "bg-primary",
  ai: "bg-primary",
  textSecondary: "bg-foreground/45",
  textMuted: "bg-foreground/25",
};

export function toneTextClass(tone: UnitTone): string {
  return TONE_TEXT[tone];
}

export function toneMarkClass(tone: UnitTone): string {
  return TONE_MARK[tone];
}

export function toneFillClass(tone: UnitTone): string {
  return TONE_FILL[tone];
}
