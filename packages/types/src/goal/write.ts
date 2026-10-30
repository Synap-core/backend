/**
 * What a goal write answered — ONE reading of every `tracks.*` write's
 * answer, for the desk's hooks (typed tRPC) and the phone's (a vanilla
 * client, `unknown`):
 *
 *   - `{ status: "proposed" }` is PROPOSED whether or not it carries a
 *     `proposalId` — never read as applied (surfaces F17); the host routes
 *     to the proposal only when the id is there;
 *   - `"unchanged"` (a move to the status it already has) is its own answer —
 *     never folded into "updated", which would say "Paused." for nothing;
 *   - the goal the write landed on (`track.id`) — reopen's NEW version, a
 *     conversion's new goal (surfaces F16).
 *
 * PURE.
 */

export type GoalWriteOutcome = "updated" | "unchanged" | "proposed";

export interface GoalWriteResult {
  outcome: GoalWriteOutcome;
  /** The proposal holding the write — `null` when the pod named none (still proposed). */
  proposalId: string | null;
  /** The goal the write landed on — reopen's new version; `null` when proposed or not said. */
  goalId: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

export function readGoalWrite(answer: unknown): GoalWriteResult {
  const bag =
    answer && typeof answer === "object"
      ? (answer as Record<string, unknown>)
      : {};
  if (bag.status === "proposed") {
    return {
      outcome: "proposed",
      proposalId: str(bag.proposalId),
      goalId: null,
    };
  }
  const track =
    bag.track && typeof bag.track === "object"
      ? (bag.track as Record<string, unknown>)
      : null;
  return {
    outcome: bag.status === "unchanged" ? "unchanged" : "updated",
    proposalId: null,
    goalId: str(track?.id) ?? str(bag.trackId),
  };
}
