/**
 * What every surface that renders run activity must agree on and none may
 * re-decide: WHERE a step opens, WHICH number counts the activity, and HOW
 * OFTEN the read refreshes. The browser session page, run-detail and relay
 * each map these answers onto their own route table / query; the answers
 * themselves live here, once (CLAUDE.md: "neither surface may fork a RULE").
 *
 * Pure: no React, no client.
 */

import type { ActivityGroup, ActivityStep, RunActivityView } from "./derive.js";
import type { SessionActivityWire } from "./wire.js";

// ── Doors ─────────────────────────────────────────────────────────────────

/**
 * Where a step opens — a platform-neutral target each surface maps onto its
 * own route table (browser `objectNavTarget`, relay `objectRouteFor`).
 *
 *   proposal     — the decision behind a decision step.
 *   object       — the object a write touched.
 *   owed         — the owed slot an ask names, by the slot's label.
 *   conversation — the session's own conversation, at one message when the
 *                  step IS a message (a note); tool steps and errors happened
 *                  in the conversation, so that is where their context is.
 */
export type ActivityStepTarget =
  | { kind: "proposal"; id: string }
  | { kind: "object"; objectKind: string; id: string; title: string | null }
  | { kind: "owed"; slotLabel: string }
  | { kind: "conversation"; messageId: string | null };

/** `null` = the step names nothing openable: render it as text, never a dead control. */
export function activityStepTarget(
  step: ActivityStep
): ActivityStepTarget | null {
  switch (step.kind) {
    case "decision":
      return step.proposalId ? { kind: "proposal", id: step.proposalId } : null;
    case "write":
      return step.objectId && step.objectKind
        ? {
            kind: "object",
            objectKind: step.objectKind,
            id: step.objectId,
            title: step.objectTitle,
          }
        : null;
    case "ask": {
      const slot = step.objectTitle?.trim();
      return slot ? { kind: "owed", slotLabel: step.objectTitle! } : null;
    }
    case "note":
      return { kind: "conversation", messageId: step.objectId };
    case "tool":
    case "error":
      return { kind: "conversation", messageId: null };
    case "lifecycle":
      return null;
  }
}

/** A group of several steps opens none of them in particular. */
export function activityGroupTarget(
  group: ActivityGroup
): ActivityStepTarget | null {
  return group.steps.length === 1 ? activityStepTarget(group.steps[0]!) : null;
}

// ── The count ─────────────────────────────────────────────────────────────

/**
 * THE number a surface shows for "how much activity" — STEPS recorded
 * (lifecycle bookends excluded), never groups. A heading, a pill, a "Show
 * all N" and a folded lede all read this, so one session reads one number on
 * the desk and on the phone.
 */
export function activityCount(view: RunActivityView): number {
  return view.summary.steps;
}

// ── Poll cadence ──────────────────────────────────────────────────────────

// How often an open session's activity is re-read. Polling is what ships
// today; whether the browser instead joins the session's room for live steps,
// and whether relay gets a socket, are PENDING FOUNDER DECISIONS (agent-run
// spec §10, "browser realtime" and "relay realtime"). This cadence is only a
// refresh rate — it claims nothing about anyone working.

/** A turn is in flight, or something happened within `ACTIVITY_RECENT_MS`. */
export const ACTIVITY_POLL_LIVE_MS = 5_000;
/** Open but quiet. */
export const ACTIVITY_POLL_IDLE_MS = 30_000;
/** How recent the last step must be for the fast cadence to hold. */
export const ACTIVITY_RECENT_MS = 2 * 60_000;

/**
 * Adaptive: fast while a turn is in flight or recent, slow otherwise, never
 * for a finished session (a record does not move). `false` stops polling.
 * Before the first answer the slow cadence applies.
 */
export function activityPollMs(
  wire: SessionActivityWire | null | undefined,
  now: number = Date.now()
): number | false {
  if (!wire) return ACTIVITY_POLL_IDLE_MS;
  if (wire.terminal) return false;
  if (wire.live.turnInFlight) return ACTIVITY_POLL_LIVE_MS;
  const last = wire.live.lastAt ? new Date(wire.live.lastAt).getTime() : NaN;
  return Number.isFinite(last) && now - last <= ACTIVITY_RECENT_MS
    ? ACTIVITY_POLL_LIVE_MS
    : ACTIVITY_POLL_IDLE_MS;
}
