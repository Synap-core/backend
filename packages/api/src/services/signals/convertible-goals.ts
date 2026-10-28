/**
 * CONVERTIBLE GOALS — the entities of a retired goal kind the viewer can read
 * that were never made a goal, read for the needs-you union (`signals.ts` ›
 * `readAttention`; founder decision D-3, 2026-10-26).
 *
 * Pods that installed Life OS, Enterprise OS or Project Management before the
 * catalog retired those kinds still hold `goal` / `objective` / `okr`
 * entities. The pod shows ONE "Make them goals" card listing them; the
 * person's act converts each through the one convert door
 * (`tracks/convert-to-goal.ts`). Nothing here writes, and nothing converts on
 * its own.
 *
 * The population is exactly what that door accepts (`loadConvertibleEntity`):
 *   - visible through the caller's own floor (`scopedDb` + the `entities`
 *     rule), live (not deleted), and listable (no probe or demo row);
 *   - its kind (the profile slug, else its legacy `type`) is one of
 *     `GOAL_CONVERTIBLE_KINDS`;
 *   - no `entity --promoted_to--> track` edge (`goalIdsMadeFrom`).
 * Each carries the projects it is filed in that the caller can see — where its
 * goal lands by default, as the single "Make it a goal" does.
 *
 * A failed read throws, and the caller names the half unreadable (`settle`).
 */

import {
  and,
  db,
  desc,
  entities,
  eq,
  inArray,
  isNull,
  links,
  listableEntityWhere,
  profiles,
  projects,
  relations,
  workspaces,
} from "@synap/database";
import { sql as drizzleSql } from "drizzle-orm";
import {
  GOAL_CONVERTIBLE_KINDS,
  isGoalConvertibleKind,
} from "@synap-core/types/units";
import { type AccessContext, scopedDb } from "../../access/index.js";
import { BELONGS_TO_PROJECT } from "../../utils/project-scope.js";
import type { ConvertibleGoalsSignalInput } from "./needs-you-union.js";

/** How many entities one read pulls before its number is a floor. */
export const CONVERTIBLE_GOALS_SCAN_LIMIT = 100;

/** The entity's kind as the convert door reads it: its profile slug, else its `type`. */
const kindSql = drizzleSql<string>`coalesce(${profiles.slug}, ${entities.type})`;

/** The viewer's convertible entities, newest first. */
export async function listConvertibleGoals(args: {
  access: AccessContext;
}): Promise<ConvertibleGoalsSignalInput> {
  const kinds: string[] = [...GOAL_CONVERTIBLE_KINDS];
  const found = await db
    .select({
      id: entities.id,
      title: entities.title,
      kind: kindSql,
      spaceName: workspaces.name,
      createdAt: entities.createdAt,
    })
    .from(entities)
    .leftJoin(profiles, eq(profiles.id, entities.profileId))
    .leftJoin(workspaces, eq(workspaces.id, entities.workspaceId))
    .where(
      and(
        isNull(entities.deletedAt),
        inArray(kindSql, kinds),
        drizzleSql`NOT EXISTS (
          SELECT 1 FROM ${links}
          WHERE ${links.fromType} = 'entity'
            AND ${links.fromId} = ${entities.id}::text
            AND ${links.toType} = 'track'
            AND ${links.linkType} = 'promoted_to'
        )`,
        scopedDb(args.access).predicate(entities),
        listableEntityWhere()
      )
    )
    .orderBy(desc(entities.createdAt), desc(entities.id))
    .limit(CONVERTIBLE_GOALS_SCAN_LIMIT + 1);
  const rows = found
    .slice(0, CONVERTIBLE_GOALS_SCAN_LIMIT)
    .flatMap((r) =>
      isGoalConvertibleKind(r.kind) ? [{ ...r, kind: r.kind }] : []
    );

  const filed = await projectsFiledIn(
    args.access,
    rows.map((r) => r.id)
  );
  return {
    rows: rows.map((r) => ({
      entityId: r.id,
      title: r.title?.trim() || null,
      kind: r.kind,
      spaceName: r.spaceName?.trim() || null,
      projectIds: filed.get(r.id) ?? [],
    })),
    truncated: found.length > CONVERTIBLE_GOALS_SCAN_LIMIT,
    newestAt: rows[0]?.createdAt ?? null,
  };
}

/** entity id → the projects it is filed in (`belongs_to_project`) that the caller can see. */
async function projectsFiledIn(
  access: AccessContext,
  entityIds: readonly string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (entityIds.length === 0) return out;
  const edges = await db
    .select({
      entityId: relations.sourceEntityId,
      projectId: relations.targetEntityId,
    })
    .from(relations)
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        inArray(relations.sourceEntityId, [...entityIds])
      )
    );
  const projectIds = [
    ...new Set(edges.flatMap((e) => (e.projectId ? [e.projectId] : []))),
  ];
  if (projectIds.length === 0) return out;
  const visible = new Set(
    (
      await scopedDb(access).findMany<{ id: string }>(projects, {
        where: inArray(projects.id, projectIds),
        columns: { id: true },
      })
    ).map((p) => p.id)
  );
  for (const e of edges) {
    if (!e.entityId || !e.projectId || !visible.has(e.projectId)) continue;
    const list = out.get(e.entityId) ?? [];
    if (!list.includes(e.projectId)) list.push(e.projectId);
    out.set(e.entityId, list);
  }
  return out;
}
