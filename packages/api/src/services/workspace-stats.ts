/**
 * Per-space size + activity — the ONE derivation (founder decisions 3B + 2C,
 * 2026-09-28).
 *
 * `readWorkspaceEntityStats` is the single count query. Two doors read it:
 *   - Hub `GET /workspaces` (`entityCount`, what `synap orient` reports);
 *   - tRPC `workspaces.stats` (Settings → Spaces: the row mark and the Restore
 *     preview), through `readSpaceStats` below.
 * Before this module the Hub held the GROUP BY inline, unfloored; a second copy
 * for the UI would have been a fork of the number agents and people both read.
 *
 * WHAT IS COUNTED — one honest definition, stated once:
 *   - `entityCount`   = live (not soft-deleted) entities filed IN the space
 *                       (`entities.workspace_id`), that the caller can see
 *                       (`scopedDb(access).predicate(entities)` — the access
 *                       layer's entity floor, not a hand-rolled predicate).
 *   - `lastActivityAt` = the latest `updated_at` among exactly those entities:
 *                       "the last time an item in this space changed". It does
 *                       NOT see sessions, messages, runs or deletions — a
 *                       space whose only recent life is a chat reads as idle.
 *                       Chosen because it is the same row set as the count, so
 *                       the two numbers on the mark can never disagree about
 *                       what the space holds. `null` = the space holds none.
 *
 * ARCHIVED SPACES (decision 2C): the pod refuses every read INSIDE an archived
 * space (`workspaces.get`, `workspaceProcedure`, `podProcedure`). This module
 * opens exactly one narrow thing: the COUNTS of an archived space, and only to
 * the people who can restore it (`canArchiveWorkspace`: owner or pod admin).
 * No content, no names beyond what `workspaces.list({ includeArchived })`
 * already returns, and never to a plain member.
 */

import {
  and,
  db,
  entities,
  inArray,
  isNull,
  workspaces,
} from "@synap/database";
import { max, sql as drizzleSql } from "drizzle-orm";
import { AccessContext, scopedDb } from "../access/index.js";
import { getUserWorkspaceIds } from "../utils/workspace-membership.js";
import {
  canArchiveWorkspace,
  countArchiveRules,
} from "../utils/workspace-archive.js";

export interface WorkspaceEntityStats {
  entityCount: number;
  lastActivityAt: Date | null;
}

/**
 * Live entity count + last activity per space, floored to what `access` may
 * see. A space with no visible entity is ABSENT from the map — callers that
 * asked about a space decide what absence means (the Hub and `readSpaceStats`
 * both read it as a measured zero, because the query succeeded).
 */
export async function readWorkspaceEntityStats(
  access: AccessContext,
  workspaceIds: readonly string[]
): Promise<Map<string, WorkspaceEntityStats>> {
  if (workspaceIds.length === 0) return new Map();
  const rows = await db
    .select({
      workspaceId: entities.workspaceId,
      count: drizzleSql<number>`cast(count(*) as integer)`,
      lastActivityAt: max(entities.updatedAt),
    })
    .from(entities)
    .where(
      and(
        inArray(entities.workspaceId, [...workspaceIds]),
        isNull(entities.deletedAt),
        scopedDb(access).predicate(entities)
      )
    )
    .groupBy(entities.workspaceId);
  const out = new Map<string, WorkspaceEntityStats>();
  for (const row of rows) {
    if (!row.workspaceId) continue;
    out.set(row.workspaceId, {
      entityCount: Number(row.count),
      lastActivityAt: toDate(row.lastActivityAt),
    });
  }
  return out;
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface SpaceStatsRow {
  workspaceId: string;
  archived: boolean;
  entityCount: number;
  /** ISO time of the last entity change in the space; null = it holds none. */
  lastActivityAt: string | null;
  /**
   * ARCHIVED rows only: the rules still paused by the archive — the set a
   * restore leaves paused (`countArchiveRules`, the restore write's own
   * predicate). `null` on a live space.
   */
  pausedRuleCount: number | null;
}

/**
 * Every space the caller can list (member ∪ pod-visible — the same set
 * `workspaces.list` draws from), with its size and activity. Archived spaces
 * are included ONLY where the caller may restore them.
 */
export async function readSpaceStats(
  userId: string,
  access: AccessContext
): Promise<SpaceStatsRow[]> {
  const ids = await getUserWorkspaceIds(userId);
  if (ids.length === 0) return [];
  const spaces = await db
    .select({
      id: workspaces.id,
      ownerId: workspaces.ownerId,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces)
    .where(inArray(workspaces.id, ids));

  const kept: Array<{ id: string; archived: boolean }> = [];
  for (const space of spaces) {
    const archived = space.archivedAt != null;
    if (archived && !(await canArchiveWorkspace(space, userId))) continue;
    kept.push({ id: space.id, archived });
  }

  const stats = await readWorkspaceEntityStats(
    access,
    kept.map((s) => s.id)
  );
  return Promise.all(
    kept.map(async ({ id, archived }) => {
      const s = stats.get(id);
      return {
        workspaceId: id,
        archived,
        entityCount: s?.entityCount ?? 0,
        lastActivityAt: s?.lastActivityAt?.toISOString() ?? null,
        pausedRuleCount: archived
          ? await countArchiveRules(db, { workspaceId: id, archive: false })
          : null,
      };
    })
  );
}
