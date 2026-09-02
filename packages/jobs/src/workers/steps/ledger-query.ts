/**
 * `runs_query` / `proposals_query` source steps — read-only access to this
 * pod's own automation-run and proposal ledgers, floored by the SAME
 * visibility predicate the Runs/Proposals surfaces use.
 */
import {
  db,
  eq,
  and,
  or,
  gte,
  inArray,
  desc,
  asc,
  automations,
  automationRuns,
  automationStepRuns,
  proposals,
  drizzleSql,
} from "@synap/database";
import type { SQL } from "@synap/database";
import {
  runsQueryVisibilityWhere,
  proposalsQueryVisibilityWhere,
} from "../ledger-query-scope.js";
import { resolveTemplate } from "../template-resolve.js";
import { coerceDateFilterValue } from "../query-dsl.js";
import { logger } from "../automation-executor-logger.js";
import type { StepContext } from "../automation-executor-types.js";

/**
 * Split a comma-separated / array-valued node field into trimmed values.
 * Shared by `runs_query`.status and `proposals_query`.{status,proposalIds}:
 * the flow editor's text controls emit a single string, template resolution can
 * yield a comma list, and hand-written JSON can carry a real array. An EMPTY
 * result returns `undefined` so the caller DROPS the filter rather than emitting
 * `IN ()` — an empty filter must never silently match zero rows (same rule as
 * `workspaceLensWhere`'s empty-array lens).
 */
export function parseMultiValueField(
  raw: unknown,
  context: StepContext
): string[] | undefined {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const resolved = resolveTemplate(v, context);
    for (const piece of resolved.split(",")) {
      const t = piece.trim();
      if (t) parts.push(t);
    }
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  return parts.length > 0 ? parts : undefined;
}

/**
 * The `status` enums as runtime value sets. Both columns are plain `text` at the
 * DB level but TS-typed unions in the schema, so a `string[]` cannot be passed
 * to `inArray` — and more importantly an author's typo must not silently widen.
 *
 * SEMANTIC (copied from `listAutomationRuns`, packages/api services/runs): a
 * status filter that resolves to NO known value returns an EMPTY result set, not
 * every row. That is the correct reading of "show me the `faild` runs" — the
 * author asked to narrow, so a bad narrow yields nothing rather than everything.
 * It is the opposite rule from `since` (dropped when unparseable) because
 * `since` failing open is visible in the output while a widened status filter
 * would look like a plausible answer.
 */
export const RUN_STATUS_VALUES = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;
type RunStatusValue = (typeof RUN_STATUS_VALUES)[number];

export const PROPOSAL_STATUS_VALUES = [
  "pending",
  "approved",
  "rejected",
  "auto_approved",
  "reverted",
  "approval_failed",
  "withdrawn",
  "expired",
] as const;
type ProposalStatusValue = (typeof PROPOSAL_STATUS_VALUES)[number];

export function narrowStatuses<T extends string>(
  raw: string[] | undefined,
  known: readonly T[]
): T[] | undefined {
  if (!raw) return undefined;
  return raw.filter((v): v is T => (known as readonly string[]).includes(v));
}

/**
 * Resolve a node's `since` field to a bound-able Date, or `undefined`.
 *
 * Same discipline as `coerceDateFilterValue` in the `query` node, and for the
 * same reason: an unparseable date is DROPPED (with a warning), never bound.
 * Dropping WIDENS the result set, which is visible to the author; binding an
 * `Invalid Date` NARROWS it to zero rows silently — a report that says "nothing
 * happened last night" when in fact everything happened.
 */
export function resolveSinceFilter(
  raw: unknown,
  context: StepContext,
  nodeType: string
): Date | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const resolved =
    typeof raw === "string" ? resolveTemplate(raw, context) : raw;
  const date = coerceDateFilterValue(resolved);
  if (!date) {
    logger.warn(
      { nodeType, since: raw, resolved },
      `${nodeType} node: dropping 'since' filter — value is not a parseable date (ISO-8601 string, epoch millis or Date expected)`
    );
    return undefined;
  }
  return date;
}

/**
 * Execute a `runs_query` SOURCE step: read this pod's own automation run ledger.
 *
 * VISIBILITY — `userVisibleWhere(automationRuns.workspaceId, ownerId)`, which is
 * the EXACT predicate `listAutomationRuns` (packages/api services/runs/index.ts)
 * applies to the same table. That consistency is the decision: a report built on
 * this node and the Runs surface in the browser must never disagree about which
 * runs exist. `ownerId` is the automation's `createdBy`, mirroring how
 * `executeQueryStep` already derives the read identity. With NO owner we fail
 * CLOSED to this workspace's own runs — an un-floored read of the ledger would
 * hand every user every other user's runs.
 *
 * SECURITY — `automation_step_runs` has NO visibility column of its own (no
 * `workspace_id`, no `user_id`; see schema/automations.ts). It is therefore only
 * ever reachable as a CHILD of an already-authorized `automation_runs` row: the
 * children query below is `inArray(runId, <ids of the rows the predicate above
 * returned>)`. It never binds a template-resolved run id — a
 * `WHERE run_id = {{trigger.payload.runId}}` would be a straight IDOR, since
 * that value is caller-supplied. The structure (fetch parents first, then
 * children BY PARENT ID) is what enforces this, not a comment.
 */
export async function executeRunsQueryStep(
  data: {
    automationId?: string;
    status?: string;
    since?: string;
    subjectEntityId?: string;
    limit?: number;
    includeSteps?: boolean;
  },
  context: StepContext,
  workspaceId: string,
  ownerId?: string
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(data.limit ?? 20), 1), 100);

  const automationId = data.automationId
    ? resolveTemplate(data.automationId, context) || undefined
    : undefined;
  const subjectEntityId = data.subjectEntityId
    ? resolveTemplate(data.subjectEntityId, context) || undefined
    : undefined;
  const rawStatuses = parseMultiValueField(data.status, context);
  const statuses: RunStatusValue[] | undefined = narrowStatuses(
    rawStatuses,
    RUN_STATUS_VALUES
  );
  // Author asked to narrow by a status nothing can ever equal → empty, never all.
  if (statuses && statuses.length === 0) {
    logger.warn(
      { status: data.status, resolved: rawStatuses },
      "runs_query node: no known run status in filter — returning an empty set rather than widening"
    );
    return { runs: [], count: 0 };
  }
  const since = resolveSinceFilter(data.since, context, "runs_query");

  const conditions: SQL[] = [
    // The user floor — identical to listAutomationRuns. Fail closed to this
    // workspace when the run has no owner identity to floor on. See
    // ledger-query-scope.ts for the full rationale + its unit proof.
    runsQueryVisibilityWhere({ workspaceId, ownerId }),
  ];
  if (automationId)
    conditions.push(eq(automationRuns.automationId, automationId));
  if (subjectEntityId)
    conditions.push(eq(automationRuns.subjectEntityId, subjectEntityId));
  if (statuses) conditions.push(inArray(automationRuns.status, statuses));
  // `gte()` (never a raw `drizzleSql` interpolation) — postgres.js cannot bind a
  // JS Date inside a raw template fragment; see postgres-sql-json lesson.
  if (since) conditions.push(gte(automationRuns.startedAt, since));

  // Projection mirrors `getRun`'s run row (services/runs/index.ts) so the report
  // and RunDetailPanel name the same fields.
  const runs = await db
    .select({
      id: automationRuns.id,
      flowName: automations.name,
      status: automationRuns.status,
      startedAt: automationRuns.startedAt,
      completedAt: automationRuns.completedAt,
      error: automationRuns.errorMessage,
      stepsCompleted: automationRuns.stepsCompleted,
      stepsFailed: automationRuns.stepsFailed,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(...conditions))
    .orderBy(desc(automationRuns.startedAt))
    .limit(limit);

  if (!data.includeSteps || runs.length === 0) {
    return {
      runs: runs.map((r) => ({ ...r, flowName: r.flowName ?? "Automation" })),
      count: runs.length,
    };
  }

  // CHILDREN — keyed ONLY by the ids of the runs the visibility predicate above
  // already returned. This is the structural IDOR guard described in the header.
  const runIds = runs.map((r) => r.id);
  const stepRows = await db
    .select({
      id: automationStepRuns.id,
      runId: automationStepRuns.runId,
      nodeId: automationStepRuns.nodeId,
      status: automationStepRuns.status,
      errorMessage: automationStepRuns.errorMessage,
      startedAt: automationStepRuns.startedAt,
      completedAt: automationStepRuns.completedAt,
    })
    .from(automationStepRuns)
    .where(inArray(automationStepRuns.runId, runIds))
    .orderBy(asc(automationStepRuns.startedAt));

  const stepsByRun = new Map<string, (typeof stepRows)[number][]>();
  for (const s of stepRows) {
    const list = stepsByRun.get(s.runId);
    if (list) list.push(s);
    else stepsByRun.set(s.runId, [s]);
  }

  return {
    runs: runs.map((r) => ({
      ...r,
      flowName: r.flowName ?? "Automation",
      steps: stepsByRun.get(r.id) ?? [],
    })),
    count: runs.length,
  };
}

/**
 * Execute a `proposals_query` SOURCE step: read this pod's own proposal queue.
 *
 * VISIBILITY — `userVisibleWhere(proposals.workspaceId, ownerId)`, the EXACT
 * predicate `routers/proposals.ts` applies to its own listing. Pod-wide
 * proposals (`workspace_id IS NULL`) therefore get the SAME handling here as
 * anywhere else in the product — deliberately NOT a special narrower rule
 * (product decision: "pod-wide proposals should have the same handling as any
 * proposal, no need to overengineer"). Fails CLOSED to this workspace when there
 * is no owner identity to floor on.
 *
 * `correlationId` / `sessionId` are the indexed columns that address a GROUP of
 * proposals — there is no proposal-group row, the shared id IS the group.
 */
export async function executeProposalsQueryStep(
  data: {
    status?: string;
    targetType?: string;
    changeType?: string;
    correlationId?: string;
    sessionId?: string;
    proposalIds?: string | string[];
    since?: string;
    limit?: number;
  },
  context: StepContext,
  workspaceId: string,
  ownerId?: string
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(data.limit ?? 20), 1), 100);

  const rawStatuses = parseMultiValueField(data.status, context);
  const statuses: ProposalStatusValue[] | undefined = narrowStatuses(
    rawStatuses,
    PROPOSAL_STATUS_VALUES
  );
  if (statuses && statuses.length === 0) {
    logger.warn(
      { status: data.status, resolved: rawStatuses },
      "proposals_query node: no known proposal status in filter — returning an empty set rather than widening"
    );
    return { proposals: [], count: 0 };
  }
  const ids = parseMultiValueField(data.proposalIds, context);
  const targetType = data.targetType
    ? resolveTemplate(data.targetType, context) || undefined
    : undefined;
  const changeType = data.changeType
    ? resolveTemplate(data.changeType, context) || undefined
    : undefined;
  const correlationId = data.correlationId
    ? resolveTemplate(data.correlationId, context) || undefined
    : undefined;
  const sessionId = data.sessionId
    ? resolveTemplate(data.sessionId, context) || undefined
    : undefined;
  const since = resolveSinceFilter(data.since, context, "proposals_query");

  const conditions: SQL[] = [
    proposalsQueryVisibilityWhere({ workspaceId, ownerId }),
  ];
  if (statuses) conditions.push(inArray(proposals.status, statuses));
  if (ids) conditions.push(inArray(proposals.id, ids));
  if (targetType) conditions.push(eq(proposals.targetType, targetType));
  if (correlationId)
    conditions.push(eq(proposals.correlationId, correlationId));
  if (sessionId) conditions.push(eq(proposals.sessionId, sessionId));
  if (since) conditions.push(gte(proposals.createdAt, since));
  if (changeType) {
    // The change kind is normalized the SAME way every review surface does it
    // (routers/proposals.ts: "Prefer changeType, fall back to proposalType") —
    // request-shaped payloads carry `data.changeType`, older/other paths only
    // have the `proposal_type` column. Matching one and not the other would make
    // the filter silently miss half the queue.
    conditions.push(
      or(
        drizzleSql`${proposals.data}->>'changeType' = ${changeType}`,
        and(
          drizzleSql`${proposals.data}->>'changeType' IS NULL`,
          eq(proposals.proposalType, changeType)
        )
      )!
    );
  }

  const rows = await db
    .select({
      id: proposals.id,
      status: proposals.status,
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      // Same COALESCE the review surfaces apply in TS.
      changeType: drizzleSql<string>`COALESCE(${proposals.data}->>'changeType', ${proposals.proposalType})`,
      // `data.summary` / `data.reasoning` are the request-shaped narration
      // fields the proposal card renders; NULL on payloads that carry neither.
      summary: drizzleSql<string | null>`${proposals.data}->>'summary'`,
      reasoning: drizzleSql<string | null>`${proposals.data}->>'reasoning'`,
      correlationId: proposals.correlationId,
      sessionId: proposals.sessionId,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(and(...conditions))
    .orderBy(desc(proposals.createdAt))
    .limit(limit);

  return { proposals: rows, count: rows.length };
}
