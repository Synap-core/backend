/**
 * BACKFILL — put every existing session that has no space but is filed in a
 * project into that project's home space (work-model plan 8daa514b, W3). It
 * ships in the same release as the space ladder: the dedup compares the space,
 * so without it a newly placed start no longer finds its open null-space twin
 * and opens a duplicate.
 *
 * The rule, generic (never a per-pod list):
 *   - a session with `workspace_id` null and a project whose home space
 *     (`projects.workspace_id`) is set moves there, through THE move
 *     (`checkSessionWorkspaceMove` + `applySessionWorkspaceMove`): its room
 *     and its artifacts re-home with it, never a raw UPDATE;
 *   - the move is checked as the session's OWNER, and a refusal (the owner
 *     cannot write there, a person in its room is not a member) is reported
 *     with its reason and the session is left as it is;
 *   - a moved session is stamped as placed by the `project_home` rung, so it
 *     keeps the project-wide reach it had for app grants (decision D2 a);
 *   - a write RECEIPT (the session the gate auto-opens for an agent's writes)
 *     keeps its space, as new receipts do (decision D9 a);
 *   - a session with neither space nor project, or whose project has no home,
 *     stays as it is;
 *   - the literal `template_id = 'null'` strings an old door wrote become NULL.
 *
 * DRY RUN by default; `apply: true` writes. Idempotent: a moved session has a
 * space and is not read again.
 */
import {
  and,
  db,
  drizzleSql,
  eq,
  focusSessions,
  isNotNull,
  isNull,
  projects,
  AGENT_PROPOSAL_PACKAGE_MARKER,
} from "@synap/database";
import {
  applySessionWorkspaceMove,
  checkSessionWorkspaceMove,
} from "./move-session-workspace.js";

export interface SessionSpaceBackfillReport {
  apply: boolean;
  /** Sessions with no space, filed in a project that has a home space. */
  candidates: number;
  moved: Array<{ sessionId: string; workspaceId: string }>;
  refused: Array<{ sessionId: string; workspaceId: string; reason: string }>;
  /** Receipts left in the caller's space (D9 a). */
  receiptsKept: number;
  /** `template_id = 'null'` strings (cleared when applying). */
  nullTemplateIds: number;
}

export async function backfillSessionSpaces(opts: {
  apply: boolean;
}): Promise<SessionSpaceBackfillReport> {
  const rows = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      channelId: focusSessions.channelId,
      metadata: focusSessions.metadata,
      homeWorkspaceId: projects.workspaceId,
    })
    .from(focusSessions)
    .innerJoin(projects, eq(projects.id, focusSessions.projectId))
    .where(
      and(isNull(focusSessions.workspaceId), isNotNull(projects.workspaceId))
    )
    .orderBy(focusSessions.startedAt, focusSessions.id);

  const report: SessionSpaceBackfillReport = {
    apply: opts.apply,
    candidates: rows.length,
    moved: [],
    refused: [],
    receiptsKept: 0,
    nullTemplateIds: 0,
  };

  for (const row of rows) {
    const workspaceId = row.homeWorkspaceId;
    // The query asked for a home; the narrowing says so to the compiler.
    if (workspaceId === null) continue;
    if (
      (row.metadata as Record<string, unknown> | null)?.kind ===
      AGENT_PROPOSAL_PACKAGE_MARKER
    ) {
      report.receiptsKept++;
      continue;
    }
    const check = await checkSessionWorkspaceMove({
      session: { id: row.id, userId: row.userId, channelId: row.channelId },
      workspaceId,
      userId: row.userId,
    });
    if (!check.ok) {
      report.refused.push({ sessionId: row.id, workspaceId, reason: check.reason });
      continue;
    }
    if (opts.apply) {
      const moved = await db.transaction(async (tx) => {
        // Re-read under a row lock: a session placed since the scan is left.
        const [current] = await tx
          .select({ workspaceId: focusSessions.workspaceId })
          .from(focusSessions)
          .where(eq(focusSessions.id, row.id))
          .for("update");
        if (!current || current.workspaceId !== null) return false;
        await applySessionWorkspaceMove(tx, {
          sessionId: row.id,
          channelId: row.channelId,
          workspaceId,
          rung: "project_home",
        });
        return true;
      });
      if (!moved) continue;
    }
    report.moved.push({ sessionId: row.id, workspaceId });
  }

  const nullTemplate = drizzleSql`${focusSessions.templateId} = 'null'`;
  if (opts.apply) {
    const cleared = await db
      .update(focusSessions)
      .set({ templateId: null })
      .where(nullTemplate)
      .returning({ id: focusSessions.id });
    report.nullTemplateIds = cleared.length;
  } else {
    const [count] = await db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(focusSessions)
      .where(nullTemplate);
    report.nullTemplateIds = count?.n ?? 0;
  }
  return report;
}
