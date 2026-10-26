/**
 * THE MERGE SWEEPER — `dev.pr_merged` completes the session outcome that IS
 * the pull request (plan v4 K, plan v5 T2). Before it, a merge was invisible
 * to the pod: 23 of 35 merged-PR outcomes still read "working" days later.
 *
 * For every session the PR resolves to (`pr-session-resolver.ts`):
 *   1. the outcome is completed through the ONE session write door,
 *      `updateFocusSession({ completeOutput })` — governed by
 *      `checkPermissionOrPropose` with the PRODUCER agent as the actor. The
 *      claim plus the slot's own `ref` (the PR url) is the existing evidence
 *      path (`satisfyClaimsByEvidence`): `done` with `satisfiedByEvidence:
 *      {kind:'ref'}`. No second `done` stamper exists or is added. This gives
 *      the producer exactly the power an agent already has through
 *      `update_session` — never more: a person's slot is refused, a slot a
 *      criterion checks stays a claim for that criterion;
 *   2. the criteria about that outcome are graded again with the merge as
 *      evidence (`recheck-criteria.ts`);
 *   3. when every outcome of the session is then met, the session is ready to
 *      close — reported as `allOutcomesMet`. The `ready_to_close` NUDGE itself
 *      belongs to lane be-context (TODO(be-context): call its nudge here once
 *      it lands); the continuation packet already derives
 *      `nextMove: ready_to_close` from the same state.
 *
 * Idempotent: a settled slot (done, withdrawn) is skipped, so a replayed or
 * duplicated event changes nothing. One session's failure never stops the
 * others; each outcome says what happened.
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, focusSessions } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import type { PullRequestEvent } from "@synap-core/types";
import { updateFocusSession } from "../focus-sessions/update-session.js";
import {
  resolvePullRequestSessions,
  type PrSessionVia,
} from "./pr-session-resolver.js";
import { recheckCriteriaForOutcome } from "./recheck-criteria.js";

const logger = createLogger({ module: "dev-loop/merge-sweeper" });

export type MergeSweepResult =
  /** The outcome is done (claim + the PR ref as evidence). */
  | "completed"
  /** Claimed, not verified: no evidence the pod accepts (no ref, a criterion checks it). */
  | "claimed"
  /** Governance filed the completion as a proposal. */
  | "proposed"
  /** Already done or withdrawn — nothing to do. */
  | "already_settled"
  /** The PR names the session, but the session never declared the PR. */
  | "no_outcome"
  /** Refused (a person's slot, a denial): the reason says why. */
  | "refused"
  | "failed";

export interface MergeSweepOutcome {
  sessionId: string;
  slotKey: string | null;
  via: PrSessionVia;
  result: MergeSweepResult;
  proposalId?: string;
  reason?: string;
  /** Every outcome of the session is met now — it is ready to close. */
  allOutcomesMet?: boolean;
}

/** Every live outcome done (withdrawn ones do not count). Pure. */
export function allOutcomesMet(raw: unknown): boolean {
  const slots = Array.isArray(raw) ? (raw as ExpectedOutput[]) : [];
  const live = slots.filter((s) => s && s.retiredAt == null);
  return live.length > 0 && live.every((s) => s.status === "done");
}

export async function sweepMergedPullRequest(input: {
  /** The person whose key posted the fact — the owner floor. */
  userId: string;
  /** The agent that posted it, when one did — the governed actor. */
  producerAgentUserId?: string | null;
  event: PullRequestEvent;
}): Promise<MergeSweepOutcome[]> {
  const { userId, event } = input;
  const agentUserId = input.producerAgentUserId ?? undefined;
  const pr = { repo: event.repo, number: event.number };
  const matches = await resolvePullRequestSessions({
    userId,
    pr,
    body: event.body ?? null,
    sessionId: event.sessionId ?? null,
  });

  const outcomes: MergeSweepOutcome[] = [];
  for (const m of matches) {
    const base = { sessionId: m.sessionId, slotKey: m.slotKey, via: m.via };
    if (m.slotKey === null) {
      outcomes.push({ ...base, result: "no_outcome" });
      continue;
    }
    if (m.settled) {
      outcomes.push({ ...base, result: "already_settled" });
      continue;
    }
    try {
      const r = await updateFocusSession({
        sessionId: m.sessionId,
        userId,
        agentUserId,
        completeOutput: m.slotKey,
      });
      if (r.status === "proposed") {
        outcomes.push({
          ...base,
          result: "proposed",
          proposalId: r.proposalId,
        });
        continue;
      }
      if (r.status !== "updated") {
        outcomes.push({
          ...base,
          result: "refused",
          reason: r.status === "denied" ? r.reason : r.status,
        });
        continue;
      }
      const report = r.completeOutput;
      const result: MergeSweepResult =
        report?.result === "completed"
          ? "completed"
          : report?.result === "claimed"
            ? "claimed"
            : "refused";

      // The criteria about this PR, graded with the merge as evidence. A
      // failed re-check never undoes the completion: it is logged and the
      // criterion keeps its last grade.
      try {
        await recheckCriteriaForOutcome({
          sessionId: m.sessionId,
          userId,
          agentUserId: agentUserId ?? null,
          outcomeKey: m.slotKey,
          evidence: { passed: true, detail: `Merged: ${event.url}` },
        });
      } catch (err) {
        logger.error(
          { err, sessionId: m.sessionId, slotKey: m.slotKey },
          "merge sweeper: criteria re-check failed"
        );
      }

      const [after] = await db
        .select({ expectedOutputs: focusSessions.expectedOutputs })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.id, m.sessionId),
            eq(focusSessions.userId, userId)
          )
        )
        .limit(1);
      const met = allOutcomesMet(after?.expectedOutputs);
      // TODO(be-context): fire the `ready_to_close` nudge here when `met`.
      outcomes.push({
        ...base,
        result,
        ...(result === "refused" && report?.message
          ? { reason: report.message }
          : {}),
        ...(met ? { allOutcomesMet: true } : {}),
      });
    } catch (err) {
      logger.error(
        { err, sessionId: m.sessionId, slotKey: m.slotKey },
        "merge sweeper: completing the outcome failed"
      );
      outcomes.push({
        ...base,
        result: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}
