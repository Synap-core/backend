/**
 * WHO IS ON A GOAL (work model W3, decision 3, 2026-10-23).
 *
 * A goal (a track) has ONE owner — a person — a JUDGE (a person; when none is
 * named, the owner judges), any number of DELEGATES (people or AIs), each with
 * a COMMITMENT they accept, counter or decline and may later report
 * impossible, and an optional INTEGRATOR. Stored in `track_participants`
 * (0348); `@synap/database` mirrors the three sets below and the pod's
 * participants service pins the mirror equal at compile time.
 *
 * Two rules every surface and every authority check reads from here:
 *   - {@link goalJudge} — the ONE answer to "who may close this goal / accept
 *     its criteria": the judge row, else the owner.
 *   - {@link commitmentMoveRefusal} — which commitment moves are allowed.
 * A delegate's refusal (declined, reported impossible) is a declined
 * COMMITMENT, never the goal's verdict (R1): only the judge closes the goal.
 *
 * PURE and dependency-free (Relay, browser, CLI and pod import the same answer).
 */

import {
  resolveTrackCommitmentStateLabel,
  type TRACK_COMMITMENT_STATE_LABELS,
  type TRACK_PARTICIPANT_ROLE_LABELS,
} from "../vocabulary/index.js";

/** The roles a participant plays on a goal. */
export const TRACK_PARTICIPANT_ROLES = [
  "owner",
  "judge",
  "delegate",
  "integrator",
] as const;
export type TrackParticipantRole = (typeof TRACK_PARTICIPANT_ROLES)[number];

/** A person (a human user) or an agent (an AI's own user row). */
export const TRACK_PRINCIPAL_KINDS = ["person", "agent"] as const;
export type TrackPrincipalKind = (typeof TRACK_PRINCIPAL_KINDS)[number];

/** Roles only a PERSON may hold: the goal's declaration stays human (R9). */
export const PERSON_ONLY_TRACK_ROLES = [
  "owner",
  "judge",
] as const satisfies readonly TrackParticipantRole[];

/**
 * Where a delegate's commitment stands. `proposed` = the delegate was ASKED
 * and has not answered; `reported_impossible` = they took it on and now say it
 * cannot be done (R10: the owner must acknowledge it).
 */
export const TRACK_COMMITMENT_STATES = [
  "proposed",
  "accepted",
  "countered",
  "declined",
  "reported_impossible",
  "done",
] as const;
export type TrackCommitmentState = (typeof TRACK_COMMITMENT_STATES)[number];

// Every role and every commitment state has its words in the vocabulary, and
// the vocabulary names nothing else: a value added on one side only stops the
// build.
type _SameKeys<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _roleWords: _SameKeys<
  TrackParticipantRole,
  keyof typeof TRACK_PARTICIPANT_ROLE_LABELS
> = true;
const _stateWords: _SameKeys<
  TrackCommitmentState,
  keyof typeof TRACK_COMMITMENT_STATE_LABELS
> = true;
void _roleWords;
void _stateWords;

/**
 * The states in which a delegate still OWES the goal something — what
 * "Silent 6 h" is measured over. A declined, done or reported commitment owes
 * nothing more from the delegate (a report waits on the owner instead).
 */
export const OPEN_COMMITMENT_STATES = [
  "proposed",
  "accepted",
  "countered",
] as const satisfies readonly TrackCommitmentState[];

export function isOpenCommitment(state: string | null | undefined): boolean {
  return (
    typeof state === "string" &&
    (OPEN_COMMITMENT_STATES as readonly string[]).includes(state)
  );
}

/**
 * An unacknowledged "impossible" report escalates to the goal's owner after
 * this many hours (R10). Adjustable here only.
 */
export const TRACK_REPORT_ESCALATE_AFTER_HOURS = 48;

/**
 * The collapse key of the R10 notification for ONE report: the participant
 * and when it reported, so a second report after a re-ask is news again.
 * Acknowledging marks every row under the participant's prefix actioned.
 */
export function trackReportGroupKeyPrefix(participantId: string): string {
  return `track-report:${participantId}:`;
}
export function trackReportGroupKey(
  participantId: string,
  reportedAt: Date | string
): string {
  return `${trackReportGroupKeyPrefix(participantId)}${new Date(reportedAt).toISOString()}`;
}

/** One participant as every read returns it (`TrackView.participants`). */
export interface TrackParticipant {
  id: string;
  principalKind: TrackPrincipalKind;
  /** A user id: the person's, or the agent's own user row. */
  principalId: string;
  role: TrackParticipantRole;
  /** What the delegate commits to — `null` for owner and judge. */
  commitment: string | null;
  /** `null` for every role but delegate. */
  commitmentState: TrackCommitmentState | null;
  /** The delegate's counter-offer, in words (state `countered`). */
  counterText: string | null;
  /** Why it cannot be done (state `reported_impossible`). */
  reportedReason: string | null;
  /** ISO-8601 — when it was reported impossible. */
  reportedAt: string | null;
  /** ISO-8601 — when the owner or judge acknowledged the report. */
  acknowledgedAt: string | null;
  /** Who made the last decision on this row (added it, or answered it). */
  decidedBy: string;
  /** ISO-8601. */
  decidedAt: string;
  /** ISO-8601 — when the participant was added. */
  createdAt: string;
  /**
   * ISO-8601 — a delegate with an OPEN commitment: the last time they did
   * anything on this goal (answered the commitment, or a session of the goal
   * they work in moved), else when they were added. `null` for every other
   * row. Words: `trackSilenceLabel` ("Silent 6 h").
   */
  silentSince: string | null;
}

type RoleRow = Pick<TrackParticipant, "role" | "principalId">;

/**
 * The goal's OWNER — its owner row; a goal with no stored owner row (none can
 * exist after 0348's backfill and `startTrack`) reads its starter, which is
 * the rule the backfill applied.
 */
export function goalOwner(
  participants: readonly RoleRow[],
  track: { userId: string }
): string {
  return (
    participants.find((p) => p.role === "owner")?.principalId ?? track.userId
  );
}

/**
 * THE JUDGE — the person who may close the goal and accept its criteria: the
 * judge row, else the owner (decision 2: the judge defaults to the owner).
 * Every authority check reads this; never re-derive it.
 */
export function goalJudge(
  participants: readonly RoleRow[],
  track: { userId: string }
): string {
  return (
    participants.find((p) => p.role === "judge")?.principalId ??
    goalOwner(participants, track)
  );
}

/** May `userId` (a person) add or remove participants? The owner or the judge. */
export function mayStaffGoal(
  participants: readonly RoleRow[],
  track: { userId: string },
  userId: string
): boolean {
  return (
    userId === goalOwner(participants, track) ||
    userId === goalJudge(participants, track)
  );
}

/** What a delegate may do to their own commitment. */
export const TRACK_COMMITMENT_MOVES = {
  accept: { from: ["proposed", "countered"], to: "accepted" },
  counter: { from: ["proposed"], to: "countered" },
  decline: { from: ["proposed", "countered", "accepted"], to: "declined" },
  report_impossible: { from: ["accepted"], to: "reported_impossible" },
} as const satisfies Record<
  string,
  {
    from: readonly TrackCommitmentState[];
    to: TrackCommitmentState;
  }
>;
export type TrackCommitmentMove = keyof typeof TRACK_COMMITMENT_MOVES;
export const TRACK_COMMITMENT_MOVE_KEYS = Object.keys(
  TRACK_COMMITMENT_MOVES
) as TrackCommitmentMove[];

export function isTrackCommitmentMove(v: unknown): v is TrackCommitmentMove {
  return typeof v === "string" && Object.hasOwn(TRACK_COMMITMENT_MOVES, v);
}

/**
 * Why `move` is not allowed on a commitment in state `from` — a sentence the
 * delegate can act on — or `null` when it is. `text` is the counter-offer
 * (required to counter) or the reason (required to report impossible).
 */
export function commitmentMoveRefusal(
  from: string | null,
  move: TrackCommitmentMove,
  text?: string | null
): string | null {
  const rule = TRACK_COMMITMENT_MOVES[move];
  if (!from || !(rule.from as readonly string[]).includes(from)) {
    return from === "reported_impossible"
      ? "This commitment was already reported impossible — the owner acknowledges it, or asks again."
      : from === "declined" || from === "done"
        ? `This commitment is ${resolveTrackCommitmentStateLabel(from).toLowerCase()} — the owner can ask again with a new commitment.`
        : move === "report_impossible"
          ? "Only an accepted commitment can be reported impossible — decline it instead."
          : `This commitment cannot be ${resolveTrackCommitmentStateLabel(rule.to).toLowerCase()} now.`;
  }
  if (move === "counter" && !text?.trim()) {
    return "Say what you would commit to instead.";
  }
  if (move === "report_impossible" && !text?.trim()) {
    return "Say why it cannot be done.";
  }
  return null;
}
