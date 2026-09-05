/**
 * Shared scope-predicate builder for `proposals.list` and `proposals.groups`.
 *
 * Both procedures need the SAME set of filter predicates (workspace three-state,
 * targetType, threadId, sessionId, projectId, agentUserId/agentOnly) so that a
 * container package's COUNT (`groups`) can never disagree with its ROWS
 * (`list`) for the same scope. Before this file the two procedures hand-rolled
 * the predicate twice — this is the ONE builder both call; do not add a second.
 *
 * The no-lens (`workspaceId: undefined`) branch is the USER FLOOR, and that
 * floor is LENS ∪ OWNERSHIP — see `proposalUserFloor` below.
 *
 * `automationId` is resolved separately (`resolveAutomationStepRunIds`, async —
 * a join, not a column) because `proposals` carries no `automationId` column,
 * only `stepRunId`; the automation is reached through `automation_step_runs`.
 */

import {
  eq,
  or,
  isNull,
  isNotNull,
  proposals,
  automationStepRuns,
  automationRuns,
  db,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { authoredByUser } from "../../services/agent-identity-service.js";

/**
 * The DEFAULT population of the proposal review queue: **LENS ∪ OWNERSHIP**.
 *
 * `userVisibleWhere` alone is a workspace-MEMBERSHIP predicate, and
 * `proposals.workspace_id` is `text` with NO foreign key — so a row whose
 * workspace is orphaned or unjoinable falls out of the lens entirely even when
 * the caller AUTHORED it. That is the measured cause of the long-standing
 * "orient says 16-17 pending, the queue says 12" split: `orient`/`diagnose`
 * already count on the union (`services/diagnose/global.ts`,
 * `services/diagnose/index.ts`, `services/proposals/pending-rules.ts`,
 * `services/runs/index.ts`, `services/diagnose/agent-scorecard.ts` all read
 * `or(userVisibleWhere(...), authoredByUser(...))`), while `proposals.list` /
 * `proposals.groups` and Hub `GET /api/hub/proposals` were the remaining
 * bare-lens doors — the ones this builder now floors.
 *
 * NOT yet on the union, deliberately: `getSignalSummary`'s "awaiting my
 * decision" metric (`services/signal/index.ts`) is still a bare lens. It was
 * classified as an open question, not a defect, and changing it would
 * desynchronize it from the run-side predicates floored beside it in the same
 * query. Do not "finish the job" here without deciding that separately.
 *
 * UNION, not ownership-replacing-lens. A workspace admin can approve a
 * TEAMMATE's proposal on membership grounds alone (`canReviewProposal` in
 * `routers/proposals/review-authority.ts` clears `admin`/`owner` regardless of
 * authorship), so dropping the lens term would delete real review coverage.
 * The union keeps every row the lens showed and ADDS the caller's own.
 *
 * `authoredByUser` carries NO membership term — its three branches are floored
 * on `createdBy = me` and on `users.createdByUserId = me AND userType='agent'`
 * (`services/agent-identity-service.ts`), so it can never admit another human's
 * rows or another human's agents'. This widens WHAT YOU SEE, never WHAT YOU MAY
 * DO: `assertProposalVisibleTo` still gates `get`/`source` and
 * `canReviewProposal` still gates approve/reject, so an own-authored row in a
 * workspace the caller cannot review lists with `viewerCanReview: false`.
 */
export function proposalUserFloor(userId: string): SQL {
  return or(
    userVisibleWhere(proposals.workspaceId, userId),
    authoredByUser(userId)
  ) as SQL;
}

/** The subset of `list`/`groups` input both procedures scope identically on. */
export interface ProposalScopeInput {
  /** Three-state: string = that workspace, null = pod-wide only, undefined = user floor. */
  workspaceId?: string | null;
  targetType?: string;
  threadId?: string;
  sessionId?: string;
  projectId?: string;
  agentUserId?: string;
  agentOnly?: boolean;
}

/**
 * Build the shared scope conditions (everything EXCEPT `status`, which each
 * caller applies with its own semantics, and the workspace editor+ gate, which
 * is a side-effecting check rather than a predicate).
 */
export function buildProposalScopeConditions(
  input: ProposalScopeInput,
  userId: string
): SQL[] {
  const conditions: SQL[] = [];

  if (input.workspaceId === null) {
    conditions.push(isNull(proposals.workspaceId));
  } else if (typeof input.workspaceId === "string") {
    conditions.push(eq(proposals.workspaceId, input.workspaceId));
  } else {
    conditions.push(proposalUserFloor(userId));
  }

  if (input.targetType) {
    conditions.push(eq(proposals.targetType, input.targetType));
  }

  if (input.threadId) {
    conditions.push(eq(proposals.threadId, input.threadId));
  }

  if (input.sessionId) {
    conditions.push(eq(proposals.sessionId, input.sessionId));
  }

  if (input.projectId) {
    conditions.push(eq(proposals.projectId, input.projectId));
  }

  if (input.agentUserId) {
    conditions.push(eq(proposals.agentUserId, input.agentUserId));
  }

  if (input.agentOnly) {
    conditions.push(isNotNull(proposals.agentUserId));
  }

  return conditions;
}

/**
 * Resolve an automation to the `stepRunId`s its runs produced, so a caller can
 * filter `proposals.stepRunId` by `inArray(...)`. Returns an empty array when
 * the automation has no step runs (or doesn't exist) — `inArray` with an empty
 * array compiles to `sql\`false\``, so the caller gets an honest empty result
 * set rather than an unfiltered one.
 */
export async function resolveAutomationStepRunIds(
  automationId: string
): Promise<string[]> {
  const rows = await db
    .select({ stepRunId: automationStepRuns.id })
    .from(automationStepRuns)
    .innerJoin(automationRuns, eq(automationRuns.id, automationStepRuns.runId))
    .where(eq(automationRuns.automationId, automationId));
  return rows.map((r) => r.stepRunId);
}
