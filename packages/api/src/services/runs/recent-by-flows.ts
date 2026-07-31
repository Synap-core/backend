import {
  db,
  eq,
  inArray,
  drizzleSql,
  automationRuns,
  playbookRuns,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import type { RunStatus } from "./types.js";

export interface RecentFlowRef {
  flowType: "automation" | "playbook";
  flowId: string;
}

export interface RecentRunsByFlowsInput {
  userId: string;
  flows: RecentFlowRef[];
  scope?: { workspaceId?: string };
  perFlowLimit?: number;
}

/**
 * Deliberately lean: these are interactive health-strip marks, not partially
 * populated `UnifiedRun`s. The exact run detail is loaded through `runs.get`.
 */
export interface RecentFlowRun {
  id: string;
  status: RunStatus;
  startedAt: Date;
  completedAt: Date | null;
}

export interface RecentFlowHistory extends RecentFlowRef {
  runs: RecentFlowRun[];
}

type RawRunRow = {
  id: string;
  flowId: string;
  status: string;
  startedAt: Date | string;
  completedAt: Date | string | null;
};

function rowsFromResult(result: unknown): RawRunRow[] {
  if (Array.isArray(result)) return result as RawRunRow[];
  return (result as { rows?: RawRunRow[] } | null)?.rows ?? [];
}

function mapRow(row: RawRunRow): RecentFlowRun {
  return {
    id: row.id,
    status: row.status as RunStatus,
    startedAt: new Date(row.startedAt),
    completedAt: row.completedAt ? new Date(row.completedAt) : null,
  };
}

async function loadAutomationHistory(
  userId: string,
  flowIds: string[],
  workspaceId: string | undefined,
  perFlowLimit: number
): Promise<Array<{ flowId: string; run: RecentFlowRun }>> {
  if (flowIds.length === 0) return [];
  const result = await db.execute(drizzleSql`
    WITH ranked AS (
      SELECT
        ${automationRuns.id} AS "id",
        ${automationRuns.automationId} AS "flowId",
        ${automationRuns.status} AS "status",
        ${automationRuns.startedAt} AS "startedAt",
        ${automationRuns.completedAt} AS "completedAt",
        row_number() OVER (
          PARTITION BY ${automationRuns.automationId}
          ORDER BY ${automationRuns.startedAt} DESC, ${automationRuns.id} ASC
        ) AS row_number
      FROM ${automationRuns}
      WHERE ${inArray(automationRuns.automationId, flowIds)}
        AND ${userVisibleWhere(automationRuns.workspaceId, userId)}
        ${workspaceId ? drizzleSql`AND ${eq(automationRuns.workspaceId, workspaceId)}` : drizzleSql``}
    )
    SELECT * FROM ranked
    WHERE row_number <= ${perFlowLimit}
    ORDER BY "flowId" ASC, "startedAt" DESC, "id" ASC
  `);
  return rowsFromResult(result).map((row) => ({
    flowId: row.flowId,
    run: mapRow(row),
  }));
}

async function loadPlaybookHistory(
  userId: string,
  flowIds: string[],
  workspaceId: string | undefined,
  perFlowLimit: number
): Promise<Array<{ flowId: string; run: RecentFlowRun }>> {
  if (flowIds.length === 0) return [];
  const result = await db.execute(drizzleSql`
    WITH ranked AS (
      SELECT
        ${playbookRuns.id} AS "id",
        ${playbookRuns.playbookId} AS "flowId",
        ${playbookRuns.status} AS "status",
        ${playbookRuns.startedAt} AS "startedAt",
        ${playbookRuns.completedAt} AS "completedAt",
        row_number() OVER (
          PARTITION BY ${playbookRuns.playbookId}
          ORDER BY ${playbookRuns.startedAt} DESC, ${playbookRuns.id} ASC
        ) AS row_number
      FROM ${playbookRuns}
      WHERE ${inArray(playbookRuns.playbookId, flowIds)}
        AND ${userVisibleWhere(playbookRuns.workspaceId, userId)}
        ${workspaceId ? drizzleSql`AND ${eq(playbookRuns.workspaceId, workspaceId)}` : drizzleSql``}
    )
    SELECT * FROM ranked
    WHERE row_number <= ${perFlowLimit}
    ORDER BY "flowId" ASC, "startedAt" DESC, "id" ASC
  `);
  return rowsFromResult(result).map((row) => ({
    flowId: row.flowId,
    run: mapRow(row),
  }));
}

/**
 * Last N executions for a bounded set of visible process definitions.
 *
 * Exactly two ledger queries at most (one per kind), regardless of flow count.
 * `row_number() partition by flow_id` applies the cap per process in Postgres,
 * avoiding both the pod-wide sampling lie and an N+1 request pattern.
 */
export async function listRecentRunsByFlows(
  input: RecentRunsByFlowsInput
): Promise<RecentFlowHistory[]> {
  const perFlowLimit = Math.min(Math.max(input.perFlowLimit ?? 20, 1), 20);
  const unique = [
    ...new Map(
      input.flows.map((flow) => [`${flow.flowType}:${flow.flowId}`, flow])
    ).values(),
  ].slice(0, 100);
  const automationIds = unique
    .filter((flow) => flow.flowType === "automation")
    .map((flow) => flow.flowId);
  const playbookIds = unique
    .filter((flow) => flow.flowType === "playbook")
    .map((flow) => flow.flowId);

  const [automationHistory, playbookHistory] = await Promise.all([
    loadAutomationHistory(
      input.userId,
      automationIds,
      input.scope?.workspaceId,
      perFlowLimit
    ),
    loadPlaybookHistory(
      input.userId,
      playbookIds,
      input.scope?.workspaceId,
      perFlowLimit
    ),
  ]);

  const runsByFlow = new Map<string, RecentFlowRun[]>();
  for (const entry of automationHistory) {
    const key = `automation:${entry.flowId}`;
    const current = runsByFlow.get(key);
    if (current) current.push(entry.run);
    else runsByFlow.set(key, [entry.run]);
  }
  for (const entry of playbookHistory) {
    const key = `playbook:${entry.flowId}`;
    const current = runsByFlow.get(key);
    if (current) current.push(entry.run);
    else runsByFlow.set(key, [entry.run]);
  }

  return unique.map((flow) => ({
    ...flow,
    runs: runsByFlow.get(`${flow.flowType}:${flow.flowId}`) ?? [],
  }));
}
