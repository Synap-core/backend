/**
 * THE PR SWEEPER — a pull request's fate moves the session outcome that IS
 * the pull request (plan v4 K, plan v5 T2). Before it, a merge was invisible
 * to the pod: 23 of 35 merged-PR outcomes still read "working" days later.
 *
 * `dev.pr_merged` INTO THE DEFAULT BRANCH (`intoDefault`, founder F3) — for
 * every session the PR resolves to (`pr-session-resolver.ts`):
 *   1. the outcome is completed through the ONE session write door,
 *      `updateFocusSession({ completeOutput })` — governed by
 *      `checkPermissionOrPropose` with the PRODUCER agent as the actor, inside
 *      the posting key's grant (founder F1: the job re-enters it, so a key
 *      allowed only `event.create` is `refused`, never completes anything).
 *      The claim plus the slot's own `ref` (the PR url) is the existing
 *      evidence path (`satisfyClaimsByEvidence`): `done` with
 *      `satisfiedByEvidence: {kind:'ref'}`. No second `done` stamper exists or
 *      is added. This gives the producer exactly the power an agent already
 *      has through `update_session` — never more: a person's slot is refused,
 *      a slot a criterion checks stays a claim for that criterion;
 *   2. the criteria about that outcome are graded again with the merge as
 *      evidence (`recheck-criteria.ts`);
 *   3. nothing else: "ready to close" is not pushed. It is DERIVED by the
 *      one rule (`attachNextMove` → `deriveNextMove`) at the next read — the
 *      packet's `nextMove`, orient's loose ends, the update reply's nudge —
 *      so a second "all outcomes met" rule here would fork it.
 * A merge into any other branch (a stacked PR merged into its parent) is not
 * delivered: `not_default_base`, the outcome stays open until the stack
 * reaches the default branch.
 *
 * `dev.pr_closed` (closed WITHOUT merging, founder F2 + the work-units rule):
 * the outcome is RETIRED through the same door (`retireOutput`, the slot is
 * withdrawn, never deleted; a person's slot is only proposed).
 *
 * Idempotent: a settled slot (done, withdrawn) is skipped, so a replayed or
 * duplicated event changes nothing. One session's failure never stops the
 * others; each outcome says what happened. A `failed` outcome is retried by
 * the job (`run-observation.ts` throws, pg-boss retries) — safe, because
 * what already settled is skipped.
 */

import { createLogger } from "@synap-core/core";
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
  /** Merged into a branch that is not the default one: not delivered yet. */
  | "not_default_base"
  /** The PR closed unmerged: the outcome is withdrawn. */
  | "retired"
  /** Claimed, not verified: no evidence the pod accepts (no ref, a criterion checks it). */
  | "claimed"
  /** Governance filed the completion as a proposal. */
  | "proposed"
  /** Already done or withdrawn — nothing to do. */
  | "already_settled"
  /** The PR names the session, but the session never declared the PR. */
  | "no_outcome"
  /** Denied by governance — the posting key's grant does not allow it (F1). */
  | "denied"
  /** Refused (a person's slot, an unknown slot): the reason says why. */
  | "refused"
  | "failed";

export interface MergeSweepOutcome {
  sessionId: string;
  slotKey: string | null;
  via: PrSessionVia;
  result: MergeSweepResult;
  proposalId?: string;
  reason?: string;
}

interface SweepInput {
  /** The person whose key posted the fact — the owner floor. */
  userId: string;
  /** The agent that posted it, when one did — the governed actor. */
  producerAgentUserId?: string | null;
  event: PullRequestEvent;
}

/** The sessions a PR resolves to, with the slots no write can move answered. */
async function resolveOpenSlots(input: SweepInput): Promise<{
  open: Array<{ base: Omit<MergeSweepOutcome, "result">; slotKey: string }>;
  answered: MergeSweepOutcome[];
}> {
  const { userId, event } = input;
  const matches = await resolvePullRequestSessions({
    userId,
    pr: { repo: event.repo, number: event.number },
    body: event.body ?? null,
    sessionId: event.sessionId ?? null,
  });
  const open: Array<{
    base: Omit<MergeSweepOutcome, "result">;
    slotKey: string;
  }> = [];
  const answered: MergeSweepOutcome[] = [];
  for (const m of matches) {
    const base = { sessionId: m.sessionId, slotKey: m.slotKey, via: m.via };
    if (m.slotKey === null) answered.push({ ...base, result: "no_outcome" });
    else if (m.settled) answered.push({ ...base, result: "already_settled" });
    else open.push({ base, slotKey: m.slotKey });
  }
  return { open, answered };
}

/** `dev.pr_merged` → the PR outcome is completed (into the default branch only). */
export async function sweepMergedPullRequest(
  input: SweepInput
): Promise<MergeSweepOutcome[]> {
  const { userId, event } = input;
  const agentUserId = input.producerAgentUserId ?? undefined;
  const { open, answered } = await resolveOpenSlots(input);
  const outcomes: MergeSweepOutcome[] = [...answered];
  for (const { base, slotKey } of open) {
    // F3: a merge into a feature branch (a stacked PR) is not on main yet.
    // Absent `intoDefault` is not known to be the default: fail closed.
    if (event.intoDefault !== true) {
      outcomes.push({
        ...base,
        result: "not_default_base",
        reason: event.base
          ? `Merged into ${event.base}, not the default branch.`
          : "The producer did not say the merge was into the default branch.",
      });
      continue;
    }
    try {
      const r = await updateFocusSession({
        sessionId: base.sessionId,
        userId,
        agentUserId,
        completeOutput: slotKey,
      });
      if (r.status === "proposed") {
        outcomes.push({
          ...base,
          result: "proposed",
          proposalId: r.proposalId,
        });
        continue;
      }
      if (r.status === "denied") {
        outcomes.push({ ...base, result: "denied", reason: r.reason });
        continue;
      }
      if (r.status !== "updated") {
        outcomes.push({ ...base, result: "refused", reason: r.status });
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
          sessionId: base.sessionId,
          userId,
          agentUserId: agentUserId ?? null,
          outcomeKey: slotKey,
          evidence: { passed: true, detail: `Merged: ${event.url}` },
        });
      } catch (err) {
        logger.error(
          { err, sessionId: base.sessionId, slotKey },
          "merge sweeper: criteria re-check failed"
        );
      }

      outcomes.push({
        ...base,
        result,
        ...(result === "refused" && report?.message
          ? { reason: report.message }
          : {}),
      });
    } catch (err) {
      logger.error(
        { err, sessionId: base.sessionId, slotKey },
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

/** `dev.pr_closed` (unmerged) → the PR outcome is withdrawn (F2). */
export async function sweepClosedPullRequest(
  input: SweepInput
): Promise<MergeSweepOutcome[]> {
  const { userId } = input;
  const agentUserId = input.producerAgentUserId ?? undefined;
  const { open, answered } = await resolveOpenSlots(input);
  const outcomes: MergeSweepOutcome[] = [...answered];
  for (const { base, slotKey } of open) {
    try {
      const r = await updateFocusSession({
        sessionId: base.sessionId,
        userId,
        agentUserId,
        retireOutput: slotKey,
      });
      if (r.status === "proposed") {
        outcomes.push({
          ...base,
          result: "proposed",
          proposalId: r.proposalId,
        });
        continue;
      }
      if (r.status === "denied") {
        outcomes.push({ ...base, result: "denied", reason: r.reason });
        continue;
      }
      if (r.status !== "updated") {
        outcomes.push({ ...base, result: "refused", reason: r.status });
        continue;
      }
      const report = r.retireOutput;
      outcomes.push({
        ...base,
        result: report?.result === "retired" ? "retired" : "refused",
        ...(report?.result !== "retired" && report?.message
          ? { reason: report.message }
          : {}),
      });
    } catch (err) {
      logger.error(
        { err, sessionId: base.sessionId, slotKey },
        "PR sweeper: retiring the outcome failed"
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
