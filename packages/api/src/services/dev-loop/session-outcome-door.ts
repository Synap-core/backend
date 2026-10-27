/**
 * The session OUTCOME doors an automation reaches once its write is GRANTED
 * (the jobs slot `utils/session-outcome-door.ts`), and the approval executor
 * reaches once a person approved the same write (`focus_session/update`).
 * ONE implementation for both, so the granted and the approved path cannot
 * fork (plan v5 T2, decision V4).
 *
 *   completeOutcome    — the claim (`applyOutputMutations` `completeOutput`,
 *                        the merge the session door uses: a person's slot is
 *                        refused) under the row lock, then the evidence
 *                        verdict (`satisfyClaimsByEvidence`). `done` keeps its
 *                        ONE stamper.
 *   postEvidence       — the evidence criteria graded through `evaluateSession`
 *                        (`kinds: ["evidence"]`, narrowed to the keys posted).
 *   reevaluateCriteria — the named criteria graded again, narrowed by
 *                        `criterionKeys`, with the event rule's kinds
 *                        (`EVENT_GRADED_KINDS`: evidence + capability, never
 *                        an LLM `judge` per event).
 *
 * GOVERNANCE IS NOT HERE: the caller decided (the automation ladder, or a
 * person's approval). Every door is OWNER-floored on `userId`.
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, focusSessions } from "@synap/database";
import type {
  OutcomeCompletion,
  OutcomeGrading,
  SessionOutcomeDoor,
} from "@synap/jobs/utils/session-outcome-door.js";
import { updateExpectedOutputsLocked } from "../focus-sessions/delegate-output.js";
import {
  applyOutputMutations,
  withEvidenceVerdict,
  type CompleteOutputOutcome,
} from "../focus-sessions/update-session.js";
import { satisfyClaimsByEvidence } from "../focus-sessions/satisfy-expected-output.js";
import { EVENT_GRADED_KINDS } from "./recheck-criteria.js";
import {
  evaluateSession,
  type EvaluateSessionResult,
} from "../focus-sessions/evaluations/evaluate.js";

const logger = createLogger({ module: "dev-loop/session-outcome-door" });

async function ownsSession(sessionId: string, userId: string) {
  const [row] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
    )
    .limit(1);
  return Boolean(row);
}

function grading(r: EvaluateSessionResult): OutcomeGrading {
  if (r.status === "not_found")
    return { status: "not_found", recorded: 0, skipped: 0 };
  return {
    status: "evaluated",
    recorded: r.results.filter((x) => x.status === "recorded").length,
    skipped: r.results.filter((x) => x.status === "skipped").length,
  };
}

export async function completeOutcome(input: {
  sessionId: string;
  userId: string;
  outcomeKey: string;
}): Promise<OutcomeCompletion> {
  if (!(await ownsSession(input.sessionId, input.userId))) {
    return { result: "no_match", message: "No such session for this owner." };
  }
  let report: CompleteOutputOutcome | undefined;
  await updateExpectedOutputsLocked(input.sessionId, (current) => {
    const applied = applyOutputMutations(
      current,
      { completeOutput: input.outcomeKey },
      { keepUnlisted: true }
    );
    report = applied.completeOutput;
    // Nothing claimed (no match, a person's slot): no write, so the row's
    // `updatedAt` does not move for a no-op.
    return report?.result === "claimed" ? applied.outputs : null;
  });
  const claimed = report as CompleteOutputOutcome | undefined;
  if (claimed?.result === "claimed") {
    // The evidence verdict is best-effort for its callers (its own contract,
    // and the approval executor's): a failed verdict leaves the CLAIM
    // standing — reported as `claimed`, never as done — and is logged.
    try {
      const verdict = await satisfyClaimsByEvidence({
        sessionId: input.sessionId,
        userId: input.userId,
      });
      report = withEvidenceVerdict(claimed, verdict.satisfied);
    } catch (err) {
      logger.warn(
        { err, sessionId: input.sessionId, outcomeKey: input.outcomeKey },
        "complete_outcome: the evidence verdict failed; the claim stands"
      );
    }
  }
  const final = report as CompleteOutputOutcome | undefined;
  return {
    result: final?.result ?? "no_match",
    ...(final?.message ? { message: final.message } : {}),
  };
}

export async function postEvidence(input: {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
  evidence: Record<string, { passed: boolean; detail?: string }>;
}): Promise<OutcomeGrading> {
  return grading(
    await evaluateSession({
      sessionId: input.sessionId,
      userId: input.userId,
      agentUserId: input.agentUserId ?? null,
      evidence: input.evidence,
      kinds: ["evidence"],
      criterionKeys: Object.keys(input.evidence),
    })
  );
}

export async function reevaluateCriteria(input: {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
  criterionKeys: string[];
}): Promise<OutcomeGrading> {
  return grading(
    await evaluateSession({
      sessionId: input.sessionId,
      userId: input.userId,
      agentUserId: input.agentUserId ?? null,
      kinds: [...EVENT_GRADED_KINDS],
      criterionKeys: input.criterionKeys,
    })
  );
}

/** What apps/api registers into the jobs slot. */
export const sessionOutcomeDoor: SessionOutcomeDoor = {
  completeOutcome,
  postEvidence,
  reevaluateCriteria,
};
