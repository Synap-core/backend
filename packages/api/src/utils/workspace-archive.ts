/**
 * Workspace archive / restore — the DB half of `workspaces.archive`.
 *
 * Callers GOVERN first (`workspaces.archive` runs `checkPermissionOrPropose`;
 * the `workspace/archive` + `workspace/restore` approval executors replay that
 * procedure). This module only performs the write, in one transaction.
 *
 * ARCHIVE pauses the workspace's SCOPED automations. The schedulers (cron tick
 * and the event-trigger matcher) select `status = 'active'` with no workspace
 * join, so an archived workspace's automations kept firing. Fixing it at the
 * source — one write when the workspace is archived — keeps both firing paths
 * unchanged. The pause is `status: 'paused'` (what `synap automation disable`
 * writes), NOT `archived` (0230's terminal soft-delete). Each paused row is
 * stamped `metadata.pausedByWorkspaceArchive` so restore can name exactly the
 * automations the archive switched off.
 *
 * Pod-wide automations (`workspace_id IS NULL`) are never touched, even when
 * they read this workspace's data — that is a separate, honest gap.
 *
 * RESTORE never re-enables anything. It returns the automations that are still
 * paused by an archive of this workspace so a surface can OFFER to re-enable
 * them (through the normal governed automation doors).
 */

import {
  and,
  automations,
  drizzleSql,
  eq,
  workspaces,
  type getDb,
} from "@synap/database";

/** The metadata key an archive stamps on each automation it pauses. */
export const PAUSED_BY_WORKSPACE_ARCHIVE_KEY = "pausedByWorkspaceArchive";

export interface ArchivedAutomationRef {
  id: string;
  name: string;
}

export interface SetWorkspaceArchivedResult {
  archivedAt: Date | null;
  /** ARCHIVE: the automations this call paused. RESTORE: always []. */
  pausedAutomations: ArchivedAutomationRef[];
  /**
   * RESTORE: automations still paused by an archive of this workspace (left
   * paused — offer re-enabling). ARCHIVE: always [].
   */
  pausedByArchive: ArchivedAutomationRef[];
}

type Db = Awaited<ReturnType<typeof getDb>>;

export async function setWorkspaceArchived(
  database: Db,
  args: { workspaceId: string; archive: boolean }
): Promise<SetWorkspaceArchivedResult> {
  const now = new Date();
  const archivedAt = args.archive ? now : null;

  return database.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({ archivedAt, updatedAt: now })
      .where(eq(workspaces.id, args.workspaceId));

    if (args.archive) {
      const stamp = JSON.stringify({
        [PAUSED_BY_WORKSPACE_ARCHIVE_KEY]: {
          workspaceId: args.workspaceId,
          at: now.toISOString(),
        },
      });
      const paused = await tx
        .update(automations)
        .set({
          status: "paused",
          metadata: drizzleSql`coalesce(${automations.metadata}, '{}'::jsonb) || ${stamp}::jsonb`,
          updatedAt: now,
        })
        .where(
          and(
            eq(automations.workspaceId, args.workspaceId),
            eq(automations.status, "active")
          )
        )
        .returning({ id: automations.id, name: automations.name });
      return {
        archivedAt,
        pausedAutomations: paused,
        pausedByArchive: [],
      };
    }

    const stillPaused = await tx
      .select({ id: automations.id, name: automations.name })
      .from(automations)
      .where(
        and(
          eq(automations.workspaceId, args.workspaceId),
          eq(automations.status, "paused"),
          drizzleSql`(${automations.metadata} -> ${PAUSED_BY_WORKSPACE_ARCHIVE_KEY}::text) is not null`
        )
      );
    return { archivedAt, pausedAutomations: [], pausedByArchive: stillPaused };
  });
}
