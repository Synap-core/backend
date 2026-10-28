/**
 * CRITERIA RE-CHECK ON EVENTS — when a fact lands on a session's outcome (a
 * PR merged, an automation posting evidence), the criteria ABOUT that outcome
 * are graded again, instead of waiting for someone to call evaluate_session.
 *
 * "About" = the criterion shares the outcome's key, or (an `evidence` check)
 * names it as its evidence key. Nothing else on the session is re-graded.
 *
 * Through the ONE grading door, `evaluateSession`, narrowed to:
 *   - `evidence` checks, with the fact posted as the evidence;
 *   - `capability` checks, re-run (a verb that reads the world — a GitHub
 *     read, a deploy probe — answers better than the event);
 * never `judge` (an LLM call per event would spend on every replay; the
 * evidence door's `kinds: ["evidence"]` makes the same choice) and never
 * `human` (the owner's).
 */

import { db, and, eq, focusSessions } from "@synap/database";
import { readCriteria } from "@synap/playbooks";
import {
  evaluateSession,
  type EvaluateSessionResult,
  type PostedEvidence,
} from "../focus-sessions/evaluations/evaluate.js";

export type RecheckResult = { status: "no_criteria" } | EvaluateSessionResult;

/**
 * The check kinds an EVENT may grade — the ONE rule for every event-driven
 * re-grade (this re-check and the automation verb `reevaluate_criterion`,
 * `session-outcome-door.ts`): `evidence` and `capability`, never `judge` (an
 * LLM call per event) nor `human`.
 */
export const EVENT_GRADED_KINDS = ["evidence", "capability"] as const;

/** The criteria of a session that are about `outcomeKey`. Pure. */
export function criteriaAboutOutcome(
  criteria: ReturnType<typeof readCriteria>,
  outcomeKey: string
) {
  return criteria.filter(
    (c) =>
      c.key === outcomeKey ||
      (c.check.kind === "evidence" && c.check.evidenceKey === outcomeKey)
  );
}

export async function recheckCriteriaForOutcome(input: {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
  outcomeKey: string;
  evidence: { passed: boolean; detail?: string };
}): Promise<RecheckResult> {
  const [row] = await db
    .select({ criteria: focusSessions.criteria })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, input.sessionId),
        eq(focusSessions.userId, input.userId)
      )
    )
    .limit(1);
  if (!row) return { status: "not_found" };
  const about = criteriaAboutOutcome(
    readCriteria(row.criteria),
    input.outcomeKey
  );
  if (about.length === 0) return { status: "no_criteria" };

  const evidence: PostedEvidence = {};
  for (const c of about) {
    if (c.check.kind === "evidence" && c.check.evidenceKey) {
      evidence[c.check.evidenceKey] = input.evidence;
    }
  }
  return evaluateSession({
    sessionId: input.sessionId,
    userId: input.userId,
    agentUserId: input.agentUserId ?? null,
    evidence,
    kinds: [...EVENT_GRADED_KINDS],
    criterionKeys: [input.outcomeKey],
  });
}
