/**
 * Shared shape and pure helpers for the entity-data half of the object graph.
 *
 * The relations router owns the database read; this module keeps the resulting
 * connection semantics consistent for that router and graph-service consumers.
 */

export type EntityConnectionSource =
  | "graph"
  | "property"
  | "thread"
  | "context_channel"
  | "focus_session";

export interface EntityConnection {
  entityId: string;
  entity: {
    title?: string | null;
    type?: string | null;
    workspaceId?: string | null;
    facetSlugs?: string[] | null;
  } | null;
  label: string;
  direction: "outgoing" | "incoming" | "structural";
  source: EntityConnectionSource;
  relationId?: string;
  relationType?: string;
  propertySlug?: string;
  propertyLabel?: string;
  channelId?: string;
  channelRelationshipType?: string;
  channelTitle?: string | null;
  channelWorkspaceId?: string | null;
  focusSessionId?: string;
  focusSessionGoal?: string;
  focusSessionStatus?: string;
  focusSessionWorkspaceId?: string | null;
  createdAt?: Date | null;
}

/**
 * Return the other endpoint and its direction for an entity_id property edge.
 * A self-reference is not a useful neighbour in the entity graph.
 */
export function structuralNeighbor(
  focusEntityId: string,
  sourceEntityId: string,
  targetEntityId: string | null
): { entityId: string; direction: "outgoing" | "incoming" } | null {
  if (!targetEntityId || sourceEntityId === targetEntityId) return null;
  if (sourceEntityId === focusEntityId) {
    return { entityId: targetEntityId, direction: "outgoing" };
  }
  if (targetEntityId === focusEntityId) {
    return { entityId: sourceEntityId, direction: "incoming" };
  }
  return null;
}

/**
 * Entity edges are only useful when their far endpoint survived the scoped,
 * non-deleted entity lookup. Channel and session edges are hydrated separately.
 */
export function filterUnavailableEntityConnections(
  connections: EntityConnection[]
): EntityConnection[] {
  return connections.filter(
    (connection) =>
      (connection.source !== "graph" && connection.source !== "property") ||
      connection.entity !== null
  );
}
