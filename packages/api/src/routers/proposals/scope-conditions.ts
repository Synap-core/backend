/**
 * Shared scope-predicate builder for `proposals.list` and `proposals.groups`.
 *
 * Both procedures need the SAME set of filter predicates (workspace three-state,
 * targetType, threadId, sessionId, projectId, agentUserId/agentOnly) so that a
 * container package's COUNT (`groups`) can never disagree with its ROWS
 * (`list`) for the same scope. Before this file the two procedures hand-rolled
 * the predicate twice — this is the ONE builder both call; do not add a second.
 *
 * `automationId` is resolved separately (`resolveAutomationStepRunIds`, async —
 * a join, not a column) because `proposals` carries no `automationId` column,
 * only `stepRunId`; the automation is reached through `automation_step_runs`.
 */

import {
  eq,
  isNull,
  isNotNull,
  proposals,
  automationStepRuns,
  automationRuns,
  db,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

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
    conditions.push(userVisibleWhere(proposals.workspaceId, userId));
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
