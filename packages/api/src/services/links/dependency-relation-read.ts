/**
 * THE relation read projection of the dependency edge.
 *
 * Entity relations `blocks` / `depends_on` live on ONE edge since 4eacdeaf +
 * migration 0301: a `links` `blocked_by` row. Every reader that speaks the
 * relation vocabulary (`relations.list/get/getRelated/getStats/getConnections`,
 * `graph.getSubgraph/getFull`, Hub `/graph/traverse`, MCP `synap_get_relations`)
 * reads dependencies through THIS file, so none of them silently loses an edge
 * the user drew. The row comes back relation-shaped (`dependencyLinkAsRelationRow`
 * in `@synap-core/types/connections` owns the slug + direction), with the LINK
 * id and `storedAs: "link"` — a writer that acts on the id (delete, undo) goes
 * through the link door (`relations.delete` routes it there).
 *
 * VISIBILITY: the link row passes the caller's lensed `links` rule (the lens
 * narrows to the edge's workspace, as it narrows a relation's), AND BOTH entity
 * endpoints pass the caller's entity floor (live, not deleted). A dependency on
 * something the reader cannot see is not a relation they may read — the node
 * neighbourhood reports it as a hidden blocker instead (`readDependencyState`).
 *
 * A failed read THROWS; it is never folded into "no dependencies".
 */

import {
  db,
  and,
  or,
  desc,
  inArray,
  isNull,
  links,
  entities,
  drizzleSql,
} from "@synap/database";
import type { relations } from "@synap/database/schema";
import {
  DEPENDENCY_LINK_TYPE,
  dependencyLinkAsRelationRow,
  isRelationDependencyType,
  type DependencyRelationRow,
} from "@synap-core/types/connections";
import { scopedDb, type AccessContext } from "../../access/index.js";

/** A relation row as the relation readers return it — plus the dependency marker. */
export type RelationReadRow = typeof relations.$inferSelect & {
  storedAs?: "link";
  /** 0301: the relation id this dependency was migrated from, if any. */
  legacyRelationId?: string | null;
};

export interface DependencyRelationQuery {
  /** The caller's relation read access (lens included). */
  access: AccessContext;
  /**
   * Restrict to edges touching these entities: `either` end in the set, or
   * `both` ends in it (a subgraph's internal edges). Omitted = every visible
   * dependency (a bulk list).
   */
  touching?: { entityIds: readonly string[]; mode: "either" | "both" };
  /** A relation slug filter. A non-dependency slug returns nothing. */
  type?: string;
  /** Newest first, at most this many. */
  limit?: number;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The relation-table shape of one projected dependency row. */
export function dependencyRowAsRelationRecord(
  row: DependencyRelationRow
): RelationReadRow {
  const m = row.metadata;
  return {
    id: row.id,
    userId: row.createdBy ?? "",
    workspaceId: row.workspaceId,
    sourceEntityId: row.sourceEntityId,
    targetEntityId: row.targetEntityId,
    sourceKind: "entity",
    targetKind: "entity",
    sourceCellId: null,
    targetCellId: null,
    type: row.type,
    metadata: m,
    createdByKind: str(m.createdByKind) as RelationReadRow["createdByKind"],
    createdByUserId: row.createdBy,
    agentUserId: str(m.agentUserId),
    sourceProposalId: str(m.sourceProposalId),
    correlationId: str(m.correlationId),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    storedAs: row.storedAs,
    legacyRelationId: row.legacyRelationId,
  };
}

/**
 * Every visible `blocked_by` entity↔entity edge matching `q`, as relation
 * records, newest first.
 */
export async function readDependencyRelations(
  q: DependencyRelationQuery
): Promise<RelationReadRow[]> {
  if (q.type !== undefined && !isRelationDependencyType(q.type)) return [];
  if (q.touching && q.touching.entityIds.length === 0) return [];

  // Both endpoints must be live entities on the caller's FLOOR (no lens: the
  // lens narrows the edge, not who the endpoints may be).
  const floor = q.access.withLens(undefined).withProjectLens(undefined);
  const visibleEntityIds = db
    .select({ id: drizzleSql<string>`${entities.id}::text` })
    .from(entities)
    .where(
      and(isNull(entities.deletedAt), scopedDb(floor).predicate(entities))
    );

  const ids = q.touching ? [...new Set(q.touching.entityIds)] : [];
  const touching = q.touching
    ? q.touching.mode === "both"
      ? and(inArray(links.fromId, ids), inArray(links.toId, ids))
      : or(inArray(links.fromId, ids), inArray(links.toId, ids))
    : undefined;

  // The slug is read from `metadata.relationType` by the ONE projection; the
  // SQL filter mirrors it (blocks ⇔ relationType = 'blocks').
  const typeFilter =
    q.type === "blocks"
      ? drizzleSql`${links.metadata}->>'relationType' = 'blocks'`
      : q.type === "depends_on"
        ? drizzleSql`coalesce(${links.metadata}->>'relationType', '') <> 'blocks'`
        : undefined;

  const query = db
    .select()
    .from(links)
    .where(
      and(
        drizzleSql`${links.linkType} = ${DEPENDENCY_LINK_TYPE}`,
        drizzleSql`${links.fromType} = 'entity'`,
        drizzleSql`${links.toType} = 'entity'`,
        scopedDb(q.access).predicate(links),
        inArray(links.fromId, visibleEntityIds),
        inArray(links.toId, visibleEntityIds),
        touching,
        typeFilter
      )
    )
    .orderBy(desc(links.createdAt), desc(links.id));
  const rows = q.limit !== undefined ? await query.limit(q.limit) : await query;

  const out: RelationReadRow[] = [];
  for (const link of rows) {
    const row = dependencyLinkAsRelationRow(link);
    if (row) out.push(dependencyRowAsRelationRecord(row));
  }
  return out;
}

/** Keep the rows where `entityId` is on the asked side of the RELATION reading. */
export function filterRelationRowsByDirection<
  T extends { sourceEntityId: string | null; targetEntityId: string | null },
>(
  rows: readonly T[],
  entityId: string,
  direction: "source" | "target" | "both"
): T[] {
  if (direction === "both") {
    return rows.filter(
      (r) => r.sourceEntityId === entityId || r.targetEntityId === entityId
    );
  }
  return rows.filter((r) =>
    direction === "source"
      ? r.sourceEntityId === entityId
      : r.targetEntityId === entityId
  );
}

/**
 * Merge two newest-first lists into one newest-first page (`id` desc breaks a
 * `createdAt` tie — the same total order `relations.list` pages on). Each input
 * must hold at least its first `offset + limit` rows for the page to be exact.
 */
export function mergeRelationPages<
  T extends { id: string; createdAt: Date | string },
>(a: readonly T[], b: readonly T[], offset: number, limit: number): T[] {
  const time = (r: T) => new Date(r.createdAt).getTime();
  return [...a, ...b]
    .sort(
      (x, y) => time(y) - time(x) || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0)
    )
    .slice(offset, offset + limit);
}
