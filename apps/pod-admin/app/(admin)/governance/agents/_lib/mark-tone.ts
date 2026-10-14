/**
 * Tone token (`@synap-core/types/units`) → this app's text colour class. The
 * tone is decided once, in the contract (`MATRIX_MARKS`, trust-ladder outcome
 * marks); this only says how pod-admin's palette draws it.
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
  textMuted: "text-foreground/40",
};

export function toneTextClass(tone: UnitTone): string {
  return TONE_TEXT[tone];
}
