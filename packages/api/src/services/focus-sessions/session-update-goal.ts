/**
 * The GOAL half of a `focus_session/update` proposal — both ends of one rule,
 * kept side by side so the producer and the executor cannot drift.
 *
 * THE DEFECT THIS REPLACES. Both proposing doors (`updateFocusSession`, the
 * MCP door, and the Hub `PATCH /focus-sessions/:id`) copied the session's
 * CURRENT goal into every payload "so summaries resolve", and the executor
 * re-applied any `goal` it found. So a filing (project, track, space) showed
 * "Goal: update" in the review diff although nothing about the goal was asked,
 * and approving an OLDER filing silently wrote its stale goal back over any
 * goal change made since (seen live on 2026-10-20: a session re-goaled by
 * `start_session` adoption was put back by approving a filing proposal).
 *
 * THE RULE.
 *  - The payload carries `goal` ONLY when the caller changes it, together with
 *    `previousGoal`: the goal the session had when the change was filed.
 *  - The executor applies `goal` only while the session still holds
 *    `previousGoal`. A goal changed since the filing is never overwritten; the
 *    approval reports it on its refusals instead.
 *  - The session is NAMED by the display-only `sessionName`
 *    (`resolveSessionTitle`, the one display-name door). The executor never
 *    reads it.
 *
 * PAYLOADS FILED BEFORE THIS RULE carry `goal` without `previousGoal`, and a
 * real goal change cannot be told from the copied snapshot. Such a goal is NOT
 * applied: applying it is the silent revert this file exists to stop, while
 * skipping it is visible — the approval's refusals say so when the goal
 * differs from the session's, and the change can be filed again.
 */
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";

/**
 * The fields a proposing door adds to its gate payload for the session's goal
 * and name. `requestedGoal` is what the caller asked for (`undefined` = not
 * asked); a goal equal to the current one is not a change.
 */
export function sessionGoalPayload(
  existing: { title?: string | null; goal: string },
  requestedGoal: string | undefined
): { sessionName?: string; goal?: string; previousGoal?: string } {
  return {
    ...sessionNameField(existing),
    ...(requestedGoal !== undefined && requestedGoal !== existing.goal
      ? { goal: requestedGoal, previousGoal: existing.goal }
      : {}),
  };
}

/**
 * The display-only `sessionName` a session proposal is titled by — also carried
 * by the close and hand-off payloads, whose executors never write the goal.
 */
export function sessionNameField(session: {
  title?: string | null;
  goal?: string | null;
}): { sessionName?: string } {
  const sessionName = resolveSessionTitle(session);
  return sessionName ? { sessionName } : {};
}

/**
 * What an approved payload does to the session's goal: `goal` to write, or a
 * `refusal` to report, or neither.
 */
export function approvedSessionGoal(
  payload: Record<string, unknown>,
  currentGoal: string
): { goal?: string; refusal?: string } {
  const goal = payload.goal;
  if (typeof goal !== "string" || goal === currentGoal) return {};
  if (typeof payload.previousGoal !== "string") {
    return {
      refusal:
        "The goal was not changed: this proposal was filed before goal changes were " +
        "tracked, so its goal may be an old copy. Ask for the goal change again if it is wanted.",
    };
  }
  if (payload.previousGoal !== currentGoal) {
    return {
      refusal:
        "The goal was not changed: the session's goal changed after this proposal " +
        "was filed, and approving it would overwrite that newer goal.",
    };
  }
  return { goal };
}
