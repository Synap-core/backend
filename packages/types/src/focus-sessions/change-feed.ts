/**
 * THE SESSION CHANGE FEED's kinds and its ONE wake rule (plan 07f8a997
 * "Agents wait on anything", W1 part A).
 *
 * `SESSION_CHANGE_KINDS` is every typed event the feed reports (the read is
 * `listSessionChanges`, backend `packages/api/src/services/focus-sessions/
 * session-changes.ts`, which re-exports this list). `isWakeWorthy` decides
 * which of them ring the doorbell: start an agent turn rather than only
 * refresh what the agent shows. The pod stamps its verdict as `wake` on every
 * event it serves (the per-session and per-conversation feeds, MCP
 * `synap_wait_for_answer` with `events`, Hub REST), so no client keeps its own
 * list. Before this rule, five clients each decided (inventory 8f64de57 §4.1):
 * synap-bridge, the CLI wake hook, the worker, `session-answer.ts`, and the
 * post door for `session_message`.
 *
 * Waking (the plan's §9 defaults): the person's answer, the owner's own words
 * in the room, a coordination post the pod marked `wake` (blocked_on_you /
 * handoff, inside its loop and rate guards), a decided proposal, a PR merged
 * or closed, checks that finished, a session this one waits on that ended, a
 * "Needs a look" signal, and a pause the pod resumed (a hold's `until` met).
 * Not waking: a stage move, any other status move, a hold being set.
 *
 * An event the woken agent caused ITSELF never rings (finding bd970b41): an
 * answer it relayed from its own chat (`relayedBy`), a proposal it decided
 * (`decidedBy`). Compared on the agent user id of the key that reads the feed,
 * which every Claude Code conversation of one computer shares: the rule only
 * applies to kinds where the agent that caused it is, by the door's own
 * check, the one waiting (a relay is refused to anyone but the asking agent
 * or a roster agent). A session another conversation of the same key ended
 * still rings (`blocker_ended` carries no actor rule).
 *
 * Zero imports: safe in browser, Electron, React Native, Node and the CLI.
 */

export const SESSION_CHANGE_KINDS = [
  "answer",
  "proposal_decided",
  "stage_moved",
  "owner_message",
  "session_message",
  "pr_merged",
  "pr_closed",
  "checks_finished",
  "status_moved",
  "hold_set",
  "blocker_ended",
  "signal_raised",
] as const;
export type SessionChangeKind = (typeof SESSION_CHANGE_KINDS)[number];

/**
 * Whether each kind CAN wake, declared once per kind. Keyed by every kind, so
 * a kind added to {@link SESSION_CHANGE_KINDS} and not classified here stops
 * the build. `"when"` = it depends on the event (see {@link isWakeWorthy}).
 */
export const SESSION_CHANGE_WAKE = {
  answer: "when",
  proposal_decided: "when",
  stage_moved: "never",
  owner_message: "always",
  session_message: "when",
  pr_merged: "always",
  pr_closed: "always",
  checks_finished: "always",
  status_moved: "when",
  hold_set: "never",
  blocker_ended: "always",
  signal_raised: "always",
} as const satisfies Record<SessionChangeKind, "always" | "never" | "when">;

/** The kinds that wake at least sometimes: what a client asks the feed for. */
export const WAKING_SESSION_CHANGE_KINDS: readonly SessionChangeKind[] =
  SESSION_CHANGE_KINDS.filter((k) => SESSION_CHANGE_WAKE[k] !== "never");

/** Who reads the feed: the agent user of the calling key, null for a person. */
export interface WakeViewer {
  agentUserId: string | null;
}

/**
 * The fields of a feed event the rule reads; the rest of the event is free.
 * Structural, so a client can classify the pod's JSON without its types.
 */
export interface WakeRuleEvent {
  kind: string;
  /** `session_message`: the pod's verdict at the post (false once read). */
  wake?: unknown;
  answer?: { relayedBy?: string | null } | null;
  proposal?: { decidedBy?: string | null } | null;
  move?: {
    from?: string | null;
    category?: string | null;
    actor?: string | null;
  } | null;
}

/**
 * A `status_moved` that ends a pause: the SYSTEM moved the session out of
 * `paused` to a live status (category active or open). That is a hold's
 * `until` met (jobs `workers/hold-resume.ts` `resumeHold`: `setSessionStatus`
 * from the paused status to its `resumeTo`, actor `system`), or the pod
 * resuming it for the person (an approved stage gate). The reaper's
 * `paused → stale` ends in category `paused`: not a resume. A person's or an
 * agent's own move is never one.
 */
export function isPauseResumed(move: WakeRuleEvent["move"]): boolean {
  return (
    move?.actor === "system" &&
    move.from === "paused" &&
    (move.category === "active" || move.category === "open")
  );
}

/**
 * THE wake rule: does this feed event start the reading agent's turn? An
 * unknown kind never wakes (a newer pod's kind reaches an older client as
 * news to show, not a doorbell).
 */
export function isWakeWorthy(
  event: WakeRuleEvent,
  viewer: WakeViewer = { agentUserId: null }
): boolean {
  if (!Object.hasOwn(SESSION_CHANGE_WAKE, event.kind)) return false;
  const rule = SESSION_CHANGE_WAKE[event.kind as SessionChangeKind];
  if (rule !== "when") return rule === "always";
  const self = viewer.agentUserId;
  switch (event.kind as SessionChangeKind) {
    case "answer":
      return !(self && event.answer?.relayedBy === self);
    case "proposal_decided":
      return !(self && event.proposal?.decidedBy === self);
    case "session_message":
      return event.wake === true;
    case "status_moved":
      return isPauseResumed(event.move);
    default:
      return false;
  }
}
