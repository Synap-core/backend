/**
 * "Ways to confirm it's you" — the ONE derivation every pod admin surface
 * reads (founder, 7 Nov 2026, session 539e519b; finding 020455d5): the
 * person's Security page, the Pod security summary, the onboarding step, the
 * top bar's mark and Home's card. Pure, so each state is tested.
 *
 * The count is the pod's (`presence.factors.waysIn`, `presenceWaysIn`): every
 * passkey together is one way, each device key one, the authenticator app
 * one, unused recovery codes one. Two ways in is the floor `enforce` keeps
 * (`PRESENCE_ENFORCE_MIN_WAYS`), so losing one never locks anyone out.
 *
 * A FAILED read is its own state, never "none" and never "enough".
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import {
  PRESENCE_ENFORCE_MIN_WAYS,
  PRESENCE_NEEDS_TWO_WAYS,
} from "@synap-core/types/presence";
import type { QueryLike } from "../../../proposal/[id]/proposal-session-model";

/** The section's anchor on the person's Security page. */
export const WAYS_IN_ANCHOR = "ways-in";

/** The one door to the person's ways in: every "add a way" link leads here. */
export const WAYS_IN_HREF = `/settings/security#${WAYS_IN_ANCHOR}`;

/** `presence.factors`: the person's ways in, counted, and the pod's mode. */
export type PresenceFactorsRead =
  inferRouterOutputs<AppRouter>["presence"]["factors"];

export type WaysIn =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      count: number;
      /** Approvals need the person in person on this pod. */
      enforce: boolean;
      /** At least the two ways `enforce` keeps. */
      enough: boolean;
    };

export function waysIn(read: QueryLike<PresenceFactorsRead>): WaysIn {
  if (read.error != null) return { kind: "failed" };
  if (read.isLoading || !read.data) return { kind: "loading" };
  const count = read.data.waysIn;
  return {
    kind: "ready",
    count,
    enforce: read.data.enforce,
    enough: count >= PRESENCE_ENFORCE_MIN_WAYS,
  };
}

/** The mark beside "Ways to confirm it's you", and the sentence under it. */
export interface WaysInMark {
  tone: "healthy" | "stale" | "unknown";
  /** "{n} of 2". */
  count: number;
  of: number;
  line:
    | "waysIn.line.enough"
    | "waysIn.line.none"
    | "waysIn.line.one"
    | "waysIn.line.report";
}

export function waysInMark(state: WaysIn): WaysInMark | null {
  if (state.kind !== "ready") return null;
  const base = { count: state.count, of: PRESENCE_ENFORCE_MIN_WAYS };
  if (state.enough) {
    return { ...base, tone: "healthy", line: "waysIn.line.enough" };
  }
  if (!state.enforce) {
    return { ...base, tone: "unknown", line: "waysIn.line.report" };
  }
  return {
    ...base,
    tone: "stale",
    line: state.count === 0 ? "waysIn.line.none" : "waysIn.line.one",
  };
}

/** The recovery codes' state as the top bar caches it (`useRecoveryCodesState`). */
export type RecoveryCodesState = "unknown" | "set" | "not_set";

/**
 * What the top bar's mark and Home's card ask for, most urgent first:
 *  - `first-way`: approvals need the person and they hold no way in;
 *  - `second-way`: approvals need the person and they hold one;
 *  - `codes`: no recovery codes (founder decision R3, 4 Oct 2026: the only
 *    way back in without email, Synap Cloud or the server);
 *  - `this-device` ("Add this device", founder decision of 9 Nov 2026): the
 *    person holds a way in, and THIS browser does not remember holding a
 *    passkey for this pod (`device-link/this-device.ts`): set one up here,
 *    so this device can approve too. An OFFER, not a warning: it never
 *    lights the top bar's mark (`nudgeMarks`). Unknown (`thisDevice` null,
 *    before the browser was read) asks for nothing;
 *  - null: nothing to ask. A failed or loading read asks for nothing: this is
 *    a nudge, not the door; the Security page shows the failure.
 */
export type SecurityNudge =
  "first-way" | "second-way" | "codes" | "this-device" | null;

export function securityNudge(
  state: WaysIn,
  codes: RecoveryCodesState,
  /** This browser remembers holding a passkey for this pod; null = unknown. */
  thisDevice: boolean | null = null
): SecurityNudge {
  if (state.kind === "ready" && state.enforce && !state.enough) {
    return state.count === 0 ? "first-way" : "second-way";
  }
  if (codes === "not_set") return "codes";
  if (state.kind === "ready" && state.count >= 1 && thisDevice === false) {
    return "this-device";
  }
  return null;
}

/**
 * Does this ask light the top bar's ⚠ mark? Every ask that guards the person
 * from being locked out does; the offer to set up this device does not.
 */
export function nudgeMarks(nudge: SecurityNudge): boolean {
  return nudge !== null && nudge !== "this-device";
}

/**
 * The pod refused a change because it would leave fewer than two ways in
 * under `enforce` (`PRESENCE_NEEDS_TWO_WAYS`): the mode switch, removing a
 * device key, the authenticator app or the last recovery codes.
 */
export function isTwoWaysRefusal(err: unknown): boolean {
  const data = (err as { data?: { reasonCode?: unknown } | null } | null)?.data;
  return data?.reasonCode === PRESENCE_NEEDS_TWO_WAYS;
}
