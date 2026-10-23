/**
 * LEAF (no db, no service imports — `permission-check.ts` imports it
 * statically): the reviewer's sentence for a change to WHO IS ON A GOAL (W3)
 * — the goal hand-off (`track/assign_agent`) and the participant changes an
 * agent files under `track/update` (`participant` on the payload). Never the
 * generic "Update track": the reviewer approves what they can read.
 */

import {
  resolveTrackCommitmentStateLabel,
  resolveTrackParticipantRoleLabel,
} from "@synap-core/types/vocabulary";
import { TRACK_COMMITMENT_MOVES } from "@synap-core/types/units";

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export function buildTrackParticipantSummary(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
): string | null {
  if (subjectType !== "track") return null;
  const goal = text(data.name);
  const onGoal = goal ? `goal "${goal}"` : "a goal";
  if (action === "assign_agent") {
    const agent = text(data.agentName) ?? "another agent";
    return `Hand ${onGoal} to ${agent}`;
  }
  if (action !== "update") return null;
  const raw = data.participant;
  if (!raw || typeof raw !== "object") return null;
  const change = raw as Record<string, unknown>;
  const who = text(change.principalName) ?? "someone";
  switch (change.op) {
    case "add":
      return `Add ${who} to ${onGoal} as ${resolveTrackParticipantRoleLabel(
        text(change.role) ?? "delegate"
      ).toLowerCase()}`;
    case "remove":
      return `Remove ${who} from ${onGoal}`;
    case "move": {
      const move = text(change.move);
      const to =
        move && Object.hasOwn(TRACK_COMMITMENT_MOVES, move)
          ? TRACK_COMMITMENT_MOVES[move as keyof typeof TRACK_COMMITMENT_MOVES]
              .to
          : null;
      return to
        ? `Mark ${who}'s commitment on ${onGoal} ${resolveTrackCommitmentStateLabel(to).toLowerCase()}`
        : null;
    }
    default:
      return null;
  }
}
