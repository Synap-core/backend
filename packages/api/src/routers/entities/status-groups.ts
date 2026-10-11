/**
 * THE ONE status grouping (work model L3): things of a kind OR a role,
 * grouped by their lifecycle status COLUMN — `entities.status` for a kind,
 * `entity_facets.status` for a role (0319, W12/W18) — with a count and a
 * capped list per group.
 *
 * Two readers, one implementation: `entities.groupByFacetStatus` (the kanban
 * primitive, newest first) and `lifecycle.board` (the pipeline read model,
 * time in column first, terminal columns windowed). Visibility is the
 * caller's: it passes the access-layer conditions (`roleVisibilityConditions`
 * / `kindVisibilityConditions` below), never a bare table scan.
 *
 * TIME IN COLUMN = the last `entity.transition.completed` of THAT lifecycle
 * (the kind's own — `role IS NULL` — or the role's), read from the event log.
 * A thing that has not moved since the door existed has no transition:
 * `enteredAt` is null and `since` falls back to when it took the role (facet)
 * or was created (kind) — reported, never passed off as a measured move.
 */
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  drizzleSql,
  facetVisibilityConditions,
  notProbeEntityWhere,
} from "@synap/database";
import { entities, entityFacets, events } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import { projectLensWhere } from "../../utils/project-scope.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";
import { entityReadVisibleWhere, entityLensWhere } from "./helpers.js";

/** Mirrors `LIFECYCLE_TRANSITION_EVENT_TYPE` (@synap/events). */
const TRANSITION_EVENT = "entity.transition.completed";

export type StatusGroupSubject =
  | { kind: "kind"; profileIds: string[] }
  | { kind: "role"; profileIds: string[]; roleSlug: string };

export interface StatusGroupItem {
  id: string;
  name: string | null;
  createdAt: string;
  /** The last transition INTO this status; null = none recorded. */
  enteredAt: string | null;
  /** `enteredAt`, else when it took the role / was created. */
  since: string;
}

export interface StatusGroup {
  status: string | null;
  count: number;
  items: StatusGroupItem[];
}

/**
 * The lens of a ROLE grouping — the facet visibility predicate AND the entity
 * floor, plus an optional project narrow. Moved verbatim from
 * `groupByFacetStatus` so the board reads roles under the SAME lens.
 */
export async function roleVisibilityConditions(input: {
  userId: string;
  /** `undefined` → no lens (the caller resolved the header already). */
  lensWorkspaceId: string | null | undefined;
  projectId?: string;
}): Promise<SQL[]> {
  const facetVisibilityScope = await resolveFacetVisibilityScope(
    input.userId,
    input.projectId ? undefined : input.lensWorkspaceId
  );
  return [
    ...facetVisibilityConditions(facetVisibilityScope),
    entityReadVisibleWhere(input.userId),
    ...(input.projectId
      ? [projectLensWhere(entities.id, input.projectId)]
      : []),
  ];
}

/**
 * The lens of a KIND grouping — `entities.list`'s rule: a project lens reads
 * the user floor narrowed to the project (intersected with an explicit
 * workspace when one is given); a workspace lens reads that workspace, plus
 * pod-wide rows for a pod-scope kind (they live nowhere else); no lens = the
 * user floor; `null` = pod-wide only.
 */
export function kindVisibilityConditions(input: {
  userId: string;
  lensWorkspaceId: string | null | undefined;
  /** True when the caller pinned the workspace (not the ambient header). */
  explicitWorkspace: boolean;
  projectId?: string;
  podScopeKind: boolean;
}): SQL[] {
  const conds: SQL[] = [notProbeEntityWhere() as SQL];
  if (input.projectId) {
    conds.push(
      input.explicitWorkspace && input.lensWorkspaceId
        ? (entityLensWhere(input.userId, input.lensWorkspaceId, {
            includePodWide: input.podScopeKind,
          }) as SQL)
        : (entityReadVisibleWhere(input.userId) as SQL),
      projectLensWhere(entities.id, input.projectId)
    );
  } else if (input.lensWorkspaceId === null) {
    conds.push(entityLensWhere(input.userId, null) as SQL);
  } else if (input.lensWorkspaceId) {
    conds.push(
      entityLensWhere(input.userId, input.lensWorkspaceId, {
        includePodWide: input.podScopeKind,
      }) as SQL
    );
  } else {
    conds.push(entityReadVisibleWhere(input.userId) as SQL);
  }
  return conds;
}

function iso(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

/**
 * Group the visible things of `subject` by status. ONE query: the base set
 * (subject + visibility), the time-in-column read, the terminal window, then a
 * per-status count and the first `firstN` items in `order`.
 *
 *   order "newest"         — created DESC (the kanban primitive).
 *   order "time_in_column" — longest in its column first; a TERMINAL status
 *                            (`terminal.statuses`) most recent first.
 *
 * `terminal.since`: a terminal status counts only things that entered it at or
 * after `since` (the pipeline's done/lost window); other statuses are never
 * windowed. A NULL status is its own group. A failed read THROWS.
 */
export async function groupThingsByStatus(params: {
  subject: StatusGroupSubject;
  conditions: SQL[];
  firstN: number;
  order: "newest" | "time_in_column";
  terminal?: { statuses: string[]; since: Date };
}): Promise<StatusGroup[]> {
  const { subject } = params;
  if (subject.profileIds.length === 0) return [];
  const isRole = subject.kind === "role";
  // Correlated, so every reference is QUALIFIED by hand: drizzle renders a
  // single-table select's columns bare, and a bare "id" inside the subquery
  // would bind to the EVENT's id (aliased `ev`), not the thing's.
  const roleMatch = isRole
    ? drizzleSql`ev.data->>'role' = ${subject.roleSlug}`
    : drizzleSql.raw(`ev.data->>'role' IS NULL`);
  const enteredAt = drizzleSql`(SELECT max(ev.timestamp) FROM ${events} ev WHERE ev.subject_type = 'entity' AND ev.subject_id = "entities"."id"::text AND ev.type = ${TRANSITION_EVENT} AND ${roleMatch})`;

  const base = isRole
    ? db
        .select({
          id: entities.id,
          name: entities.title,
          createdAt: drizzleSql`${entities.createdAt}`.as("created_at"),
          status: drizzleSql<string | null>`${entityFacets.status}`.as(
            "status"
          ),
          enteredAt: enteredAt.as("entered_at"),
          fallbackAt: drizzleSql`${entityFacets.createdAt}`.as("fallback_at"),
        })
        .from(entityFacets)
        .innerJoin(entities, eq(entities.id, entityFacets.entityId))
        .where(
          and(
            inArray(entityFacets.profileId, subject.profileIds),
            isNull(entityFacets.deletedAt),
            isNull(entities.deletedAt),
            ...params.conditions
          )
        )
    : db
        .select({
          id: entities.id,
          name: entities.title,
          createdAt: drizzleSql`${entities.createdAt}`.as("created_at"),
          status: drizzleSql<string | null>`${entities.status}`.as("status"),
          enteredAt: enteredAt.as("entered_at"),
          fallbackAt: drizzleSql`${entities.createdAt}`.as("fallback_at"),
        })
        .from(entities)
        .where(
          and(
            inArray(entities.profileId, subject.profileIds),
            isNull(entities.deletedAt),
            ...params.conditions
          )
        );
  const t = base.as("t");

  const since = drizzleSql`coalesce(${t.enteredAt}, ${t.fallbackAt})`;
  const terminal = params.terminal?.statuses.length ? params.terminal : null;
  const isTerminal = terminal
    ? drizzleSql`coalesce(${t.status} IN (${drizzleSql.join(
        terminal.statuses.map((s) => drizzleSql`${s}`),
        drizzleSql`, `
      )}), false)`
    : drizzleSql`false`;
  const orderBy =
    params.order === "newest"
      ? drizzleSql`${t.createdAt} DESC, ${t.id}`
      : drizzleSql`CASE WHEN ${isTerminal} THEN -extract(epoch from ${since}) ELSE extract(epoch from ${since}) END, ${t.id}`;
  const windowFilter = terminal
    ? drizzleSql`(NOT ${isTerminal} OR ${since} >= ${terminal.since.toISOString()}::timestamptz)`
    : drizzleSql`true`;

  const ranked = db
    .select({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      status: t.status,
      enteredAt: t.enteredAt,
      since: since.as("since"),
      rn: drizzleSql<number>`row_number() OVER (PARTITION BY ${t.status} ORDER BY ${orderBy})`.as(
        "rn"
      ),
      groupCount:
        drizzleSql<number>`cast(count(*) OVER (PARTITION BY ${t.status}) as integer)`.as(
          "group_count"
        ),
    })
    .from(t)
    .where(windowFilter)
    .as("r");

  // At least one row per group survives, so a counts-only call (firstN 0)
  // still sees every group's count.
  const rows = await db
    .select()
    .from(ranked)
    .where(drizzleSql`${ranked.rn} <= ${Math.max(params.firstN, 1)}`)
    .orderBy(ranked.status, ranked.rn);

  const groups = new Map<string | null, StatusGroup>();
  for (const r of rows) {
    const key = (r.status as string | null) ?? null;
    let g = groups.get(key);
    if (!g) {
      g = { status: key, count: Number(r.groupCount), items: [] };
      groups.set(key, g);
    }
    if (Number(r.rn) <= params.firstN) {
      g.items.push({
        id: r.id as string,
        name: (r.name as string | null) ?? null,
        createdAt: iso(r.createdAt),
        enteredAt: r.enteredAt == null ? null : iso(r.enteredAt),
        since: iso(r.since),
      });
    }
  }
  return [...groups.values()];
}
