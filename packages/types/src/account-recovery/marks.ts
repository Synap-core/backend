/**
 * The ONE derivation of how account recovery READS on every surface
 * (pod-admin, Relay, the desktop app): the recovery-codes mark, the copy for
 * each "Can't sign in?" door, and the message a locked-out person sends to
 * whoever runs their pod. Two surfaces hand-writing these is how "2 left" on
 * one screen and "2 of 10 left" on the other happened.
 *
 * Marks return TOKENS, never colours (ui-composition §1): a tone the surface
 * maps to its own palette, and a glyph the surface maps to its own icon set.
 * `glyph` names are the `UnitGlyph` names (`@synap-core/types/units`).
 * `tone` adds `warning`, which `UnitTone` deliberately lacks — codes that are
 * not set are a persistent warning, not an error (founder decision R3).
 *
 * Pure + dependency-free.
 */

import type { AccountRecoveryStatus } from "./index.js";

/** Tone tokens a pod-safety mark can carry. Names match Relay's `ChipTone`. */
export type RecoveryMarkTone = "success" | "warning" | "error" | "neutral";
/** Glyph tokens — a subset of `UnitGlyph`. */
export type RecoveryMarkGlyph = "check" | "alert";

export interface RecoveryMark {
  tone: RecoveryMarkTone;
  glyph: RecoveryMarkGlyph;
  label: string;
}

/** At or under this many codes, a batch is "running low". */
export const RECOVERY_CODES_LOW_AT = 2;

/**
 * Recovery codes as a MARK.
 *
 *   never made (total 0)          → warning "Not set"
 *   a batch, all used (remaining 0) → error   "None left"
 *   remaining ≤ 2                  → warning "N of M left"
 *   otherwise                      → success "N of M left"
 *
 * NB the pod reports `set: remaining > 0`, so a used-up batch arrives as
 * `set: false` — "None left" is told apart from "Not set" by `total`, not by
 * `set`. Reading `set` first would make "None left" unreachable.
 */
export function recoveryCodesMark(
  codes: AccountRecoveryStatus["recoveryCodes"]
): RecoveryMark {
  if (codes.remaining <= 0 && codes.total > 0) {
    return { tone: "error", glyph: "alert", label: "None left" };
  }
  if (!codes.set || codes.remaining <= 0) {
    return { tone: "warning", glyph: "alert", label: "Not set" };
  }
  const label = `${codes.remaining} of ${codes.total} left`;
  if (codes.remaining <= RECOVERY_CODES_LOW_AT) {
    return { tone: "warning", glyph: "alert", label };
  }
  return { tone: "success", glyph: "check", label };
}

/** The verb, everywhere: the button, the invite, the nudge. */
export const CREATE_RECOVERY_CODES_LABEL = "Create recovery codes";

/** Every way back in a "Can't sign in?" screen can offer, pod doors first. */
export type RecoveryDoorCopyKey =
  | "recoveryCode"
  | "email"
  | "cloud"
  | "cloudAccountReset";

/**
 * One title + one-line body per door. `recoveryCode` / `email` / `cloud` are
 * the pod's {@link RecoveryDoors}; `cloudAccountReset` is the Synap Cloud
 * account's OWN password reset — a different account from the pod's.
 */
export const RECOVERY_DOOR_COPY: Readonly<
  Record<RecoveryDoorCopyKey, { title: string; body: string }>
> = {
  recoveryCode: {
    title: "Use a recovery code",
    body: "One of the codes you saved for this pod",
  },
  email: {
    title: "Email me a code",
    body: "The pod sends a code to your account email",
  },
  cloud: {
    title: "Continue with Synap Cloud",
    body: "Your Synap Cloud account signs you in",
  },
  cloudAccountReset: {
    title: "Forgot your Synap Cloud password",
    body: "Your Synap Cloud account is separate from this pod",
  },
};

/** The EXPLAIN state when no door works on this pod. */
export const RECOVERY_NO_DOORS_COPY = {
  title: "This pod has no way to recover your account yet",
  body: "Ask whoever runs your pod to reset it.",
} as const;

/** The operator's break-glass, run on the pod's server. */
export function operatorResetCommand(email: string): string {
  const who = email.trim() || "<email>";
  return `synap users reset-password ${who}`;
}

/**
 * What a locked-out person sends to whoever runs their pod. The command lives
 * in the MESSAGE (copied), never inline in body copy.
 */
export function operatorResetMessage(email: string, podHost?: string | null): string {
  const pod = podHost?.trim() ? ` on ${podHost.trim()}` : "";
  return [
    `I can't sign in to my Synap pod${pod}. Could you reset my password?`,
    "On the pod's server, run:",
    "",
    operatorResetCommand(email),
  ].join("\n");
}
