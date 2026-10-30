/**
 * Box runs in the ONE runs read layer (`services/runs`): a box run is a
 * CAPABILITY run (run box design C1 — "never a new runs page"), so the Runs
 * feed, the run object page and a session's runs list it beside every other
 * capability run, with its log, files and evidence on the detail.
 *
 * Read floor = the requester (`box_runs.user_id`), the same `workspaceOwned`
 * rule access/registry.ts declares for the table, narrowed by the feed's lens.
 * A project lens contributes nothing (a box run carries no project), which is
 * the feed's rule for every ledger without the column.
 */

import { and, count, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { db } from "@synap/database";
import {
  BOX_RUN_STATUSES,
  boxRuns,
  users,
  type BoxRunRow,
  type BoxRunStatus,
} from "@synap/database/schema";
import type { BoxRunDetail, RunStatus, UnifiedRun } from "../runs/types.js";
import { boxRunReadStatus, type BoxRunReadStatus } from "./box-runs.js";

/**
 * `box_runs.id` is a uuid column, and the run doors pass ids of every ledger
 * (a correlation id, a chat turn id): only a uuid-shaped one is looked up here,
 * so a foreign id is "not a box run", never a Postgres syntax error.
 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The unified status of a box run's read status. */
export function unifiedBoxRunStatus(status: BoxRunReadStatus): RunStatus {
  switch (status) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
    default:
      // queued / leased / running / stalled: the run is not over.
      return "running";
  }
}

/** The stored statuses a unified status filter selects (the inverse map). */
function storedStatusesFor(status: RunStatus): BoxRunStatus[] {
  return BOX_RUN_STATUSES.filter((s) => unifiedBoxRunStatus(s) === status);
}

/** What only the run page's read knows: who took it, where it waits. */
export interface BoxRunPlace {
  computerName?: string | null;
  queuePosition?: number | null;
}

/**
 * Where a box run stands, in one sentence: the ONE derivation, drawn by the
 * Runs feed and the run page (`summary`) alike. The page's read passes the
 * computer and the queue position it loads; the feed has neither.
 */
export function boxRunSummary(
  run: Pick<BoxRunRow, "stopRequestedAt" | "evidence">,
  status: BoxRunReadStatus,
  place: BoxRunPlace = {}
): string {
  const computer = place.computerName ?? "your computer";
  const stopping = run.stopRequestedAt !== null;
  switch (status) {
    case "queued":
      return place.queuePosition && place.queuePosition > 1
        ? `Waiting for your computer · ${place.queuePosition - 1} ahead of it`
        : "Waiting for your computer to pick it up";
    case "leased":
      return stopping ? "Stopping" : `Setting up a box on ${computer}`;
    case "running":
      return stopping ? "Stopping" : `Running in a box on ${computer}`;
    case "stalled":
      return `Stalled: ${computer} stopped answering while the script ran`;
    case "stopped":
      return "Stopped";
    case "done": {
      const files = run.evidence?.files.length ?? 0;
      return files > 0
        ? `Finished · ${files} file${files === 1 ? "" : "s"}`
        : "Finished";
    }
    case "failed":
      return run.evidence?.verdict === "infra"
        ? "Did not run to the end: a problem on the computer, not in the script"
        : run.evidence?.verdict === "timeout"
          ? "Ran past its time limit and was stopped"
          : "The script failed";
  }
}

export function boxRunAsUnifiedRun(
  run: BoxRunRow,
  now: Date = new Date(),
  place: BoxRunPlace = {}
): UnifiedRun {
  const status = boxRunReadStatus(run, now);
  return {
    id: run.id,
    flowType: "capability",
    flowId: null,
    flowName: run.spec.name,
    status: unifiedBoxRunStatus(status),
    startedAt: run.queuedAt,
    completedAt: run.finishedAt,
    // A heartbeat is progress evidence; a queued run has none yet (UNKNOWN,
    // never "idle": it is waiting for a computer, which is not a stall).
    lastActivityAt:
      run.status === "leased" || run.status === "running"
        ? run.lastHeartbeatAt
        : null,
    workspaceId: run.workspaceId,
    projectId: null,
    subjectEntityId: null,
    channelId: null,
    correlationId: null,
    replayOf: null,
    summary: boxRunSummary(run, status, place),
    error: run.status === "failed" ? run.error : null,
    triggeredBy: run.agentUserId ?? run.userId,
    stepsCompleted: null,
    stepsFailed: null,
    definitionVersion: null,
  };
}

export interface BoxRunLens {
  workspaceId?: string;
  projectId?: string;
  subjectEntityId?: string;
  sessionId?: string;
  /** The runs of these skills (`RunScope.skillIds`); empty matches nothing. */
  skillIds?: readonly string[];
  startedBefore?: Date;
}

/** The requester's box runs under the feed's lens, newest first. */
export async function listBoxRunsForFeed(
  userId: string,
  lens: BoxRunLens,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  if (lens.projectId || lens.subjectEntityId) return [];
  if (lens.skillIds && lens.skillIds.length === 0) return [];
  if (exactRunId !== undefined && !UUID_SHAPE.test(exactRunId)) return [];
  const stored = status ? storedStatusesFor(status) : null;
  if (stored && stored.length === 0) return [];
  const where: Array<SQL | undefined> = [
    eq(boxRuns.userId, userId),
    exactRunId ? eq(boxRuns.id, exactRunId) : undefined,
    lens.workspaceId ? eq(boxRuns.workspaceId, lens.workspaceId) : undefined,
    lens.sessionId ? eq(boxRuns.sessionId, lens.sessionId) : undefined,
    lens.skillIds ? inArray(boxRuns.skillId, [...lens.skillIds]) : undefined,
    lens.startedBefore ? lt(boxRuns.queuedAt, lens.startedBefore) : undefined,
    stored ? inArray(boxRuns.status, stored) : undefined,
  ];
  const rows = await db
    .select()
    .from(boxRuns)
    .where(and(...where))
    .orderBy(desc(boxRuns.queuedAt))
    .limit(limit);
  const now = new Date();
  return rows.map((r) => boxRunAsUnifiedRun(r, now));
}

/** The run object's box section, or null when the id is not the reader's box run. */
export async function loadBoxRunDetail(
  userId: string,
  id: string
): Promise<{ run: UnifiedRun; boxRun: BoxRunDetail } | null> {
  if (!UUID_SHAPE.test(id)) return null;
  const [row] = await db
    .select()
    .from(boxRuns)
    .where(and(eq(boxRuns.id, id), eq(boxRuns.userId, userId)))
    .limit(1);
  if (!row) return null;
  const now = new Date();
  const status = boxRunReadStatus(row, now);
  const [computer] = row.leasedBy
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, row.leasedBy))
        .limit(1)
    : [];
  let queuePosition: number | null = null;
  if (row.status === "queued") {
    const [ahead] = await db
      .select({ n: count() })
      .from(boxRuns)
      .where(
        and(
          eq(boxRuns.userId, row.userId),
          inArray(boxRuns.status, ["queued", "leased", "running"]),
          lt(boxRuns.queuedAt, row.queuedAt)
        )
      );
    queuePosition = Number(ahead?.n ?? 0) + 1;
  }
  return {
    run: boxRunAsUnifiedRun(row, now, {
      computerName: computer?.name ?? null,
      queuePosition,
    }),
    boxRun: {
      status,
      skillId: row.skillId,
      script: row.spec,
      parameters: row.parameters,
      computerName: computer?.name ?? null,
      queuePosition,
      attempt: row.attempt,
      stopRequested: row.stopRequestedAt !== null,
      queuedAt: row.queuedAt,
      leasedAt: row.leasedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      error: row.error,
      evidence: row.evidence,
    },
  };
}
