/**
 * PROJECT TWINS (ticket 8e2c7018): the ONE definition of a live entity that
 * twins a project.
 *
 * Migration 0151 copied each project entity into the `projects` table WITH THE
 * SAME ID and left the entity row behind; a reserved `project` kind could be
 * re-activated by a template written before the catalog refused it. Either
 * shape answers recall with the project's stale facts while the table holds
 * the current ones. A twin is a live entity whose id is a `projects.id`, or
 * whose profile is on a reserved slug (`isReservedProfileSlug`, the write
 * paths' door, so no second list of slugs here).
 *
 * Read by `synap_diagnose` (schema contract, owner-floored) and by the
 * `retireProjectTwins` conversion (pod-wide), so the report and the repair
 * cannot disagree about which rows are twins.
 */

import type { Sql } from "postgres";
import { isReservedProfileSlug } from "./reserved-profile-slugs.js";

export type ProjectTwinReason = "id_is_a_project" | "reserved_kind";

export interface ProjectTwinRow {
  entityId: string;
  title: string | null;
  workspaceId: string | null;
  reasons: ProjectTwinReason[];
}

/**
 * Every live project twin, or only `userId`'s when given. Reserved profile
 * rows are matched whatever their `is_active`: a row 0151 deactivated still
 * names the kind its entities were written on.
 */
export async function selectProjectTwins(
  sql: Sql,
  opts: { userId?: string } = {}
): Promise<ProjectTwinRow[]> {
  const profileRows = await sql<Array<{ id: string; slug: string }>>`
    SELECT id, slug FROM profiles
  `;
  const reserved = profileRows
    .filter((p) => isReservedProfileSlug(p.slug))
    .map((p) => p.id);
  const userId = opts.userId ?? null;
  const rows = await sql<
    Array<{
      entity_id: string;
      title: string | null;
      workspace_id: string | null;
      is_project: boolean;
      reserved_kind: boolean;
    }>
  >`
    SELECT e.id AS entity_id, e.title, e.workspace_id,
      (p.id IS NOT NULL) AS is_project,
      COALESCE(e.profile_id = ANY(${reserved}::uuid[]), false) AS reserved_kind
    FROM entities e
    LEFT JOIN projects p ON p.id = e.id
    WHERE e.deleted_at IS NULL
      AND (${userId}::text IS NULL OR e.user_id::text = ${userId}::text)
      AND (p.id IS NOT NULL OR e.profile_id = ANY(${reserved}::uuid[]))
    ORDER BY e.id
  `;
  return rows.map((r) => ({
    entityId: r.entity_id,
    title: r.title,
    workspaceId: r.workspace_id,
    reasons: [
      ...(r.is_project ? (["id_is_a_project"] as const) : []),
      ...(r.reserved_kind ? (["reserved_kind"] as const) : []),
    ],
  }));
}
