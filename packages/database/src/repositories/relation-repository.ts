/**
 * Relation Repository
 *
 * Handles all entity relation CRUD operations with automatic event emission
 */

import { eq, and } from "drizzle-orm";
import { relations } from "../schema/relations.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Relation, NewRelation } from "../schema/relations.js";
import { sql } from "../client-pg.js";

export interface CreateRelationInput {
  id?: string;
  sourceEntityId: string;
  targetEntityId: string;
  /** Relation type slug (from workspace relation_defs or system types) */
  type: string;
  workspaceId?: string | null;
  userId: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRelationInput {
  type?: string;
  metadata?: Record<string, unknown>;
}

export class RelationRepository extends BaseRepository<
  Relation,
  CreateRelationInput,
  UpdateRelationInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "relation", pluralName: "relations" });
  }

  /**
   * Create a new relation between entities
   * Emits: relations.create.completed
   */
  async create(data: CreateRelationInput, userId: string): Promise<Relation> {
    // Type validation is handled by the caller (router validates against
    // workspace relation_defs and system types)

    const [relation] = await this.db
      .insert(relations)
      .values({
        id: data.id,
        sourceEntityId: data.sourceEntityId,
        targetEntityId: data.targetEntityId,
        type: data.type,
        workspaceId: data.workspaceId,
        userId: data.userId,
        metadata: data.metadata || {},
      } as NewRelation)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", relation, userId);

    return relation;
  }

  /**
   * Update an existing relation
   * Emits: relations.update.completed
   */
  async update(
    id: string,
    data: UpdateRelationInput,
    userId: string
  ): Promise<Relation> {
    const updates: Partial<NewRelation> = {};
    if (data.type !== undefined) updates.type = data.type;
    if (data.metadata !== undefined) updates.metadata = data.metadata as any;

    const [relation] = await this.db
      .update(relations)
      .set(updates)
      .where(and(eq(relations.id, id), eq(relations.userId, userId)))
      .returning();

    if (!relation) {
      throw new Error("Relation not found");
    }

    // Emit completed event
    await this.emitCompleted("update", relation, userId);

    return relation;
  }

  /**
   * Traverse the entity relation graph via iterative BFS.
   * Returns all reachable entities within maxDepth hops from startEntityId.
   */
  async traverseGraph(params: {
    userId: string;
    startEntityId: string;
    maxDepth?: number;
    relationshipTypes?: string[];
  }): Promise<
    Array<{
      entityId: string;
      depth: number;
      relationshipType: string;
      direction: "outbound" | "inbound";
      path: string[];
    }>
  > {
    const { userId, startEntityId, maxDepth = 2, relationshipTypes } = params;
    const safeDepth = Math.min(maxDepth, 3);

    const visited = new Set<string>([startEntityId]);
    const results: Array<{
      entityId: string;
      depth: number;
      relationshipType: string;
      direction: "outbound" | "inbound";
      path: string[];
    }> = [];
    let frontier = [
      { entityId: startEntityId, depth: 0, path: [startEntityId] },
    ];

    while (frontier.length > 0 && frontier[0].depth < safeDepth) {
      const next: typeof frontier = [];

      for (const node of frontier) {
        let rows: Array<{
          source_entity_id: string;
          target_entity_id: string;
          type: string;
        }>;

        if (relationshipTypes && relationshipTypes.length > 0) {
          rows = await sql<typeof rows>`
            SELECT source_entity_id, target_entity_id, type
            FROM relations
            WHERE user_id = ${userId}
              AND type = ANY(${relationshipTypes})
              AND (source_entity_id = ${node.entityId} OR target_entity_id = ${node.entityId})
            LIMIT 50
          `;
        } else {
          rows = await sql<typeof rows>`
            SELECT source_entity_id, target_entity_id, type
            FROM relations
            WHERE user_id = ${userId}
              AND (source_entity_id = ${node.entityId} OR target_entity_id = ${node.entityId})
            LIMIT 50
          `;
        }

        for (const row of rows) {
          const isOutbound = row.source_entity_id === node.entityId;
          const neighborId = isOutbound
            ? row.target_entity_id
            : row.source_entity_id;

          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            const newPath = [...node.path, neighborId];
            results.push({
              entityId: neighborId,
              depth: node.depth + 1,
              relationshipType: row.type,
              direction: isOutbound ? "outbound" : "inbound",
              path: newPath,
            });
            next.push({
              entityId: neighborId,
              depth: node.depth + 1,
              path: newPath,
            });
          }
        }
      }

      frontier = next;
    }

    return results;
  }

  /**
   * Delete a relation
   * Emits: relations.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(relations)
      .where(and(eq(relations.id, id), eq(relations.userId, userId)))
      .returning({ id: relations.id });

    if (result.length === 0) {
      throw new Error("Relation not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}

/**
 * Standalone graph traversal function (read-only, no event system needed).
 * Exposed for direct use from API routers without needing a full RelationRepository instance.
 */
export async function traverseEntityGraph(params: {
  userId: string;
  startEntityId: string;
  maxDepth?: number;
  relationshipTypes?: string[];
  /** When set, only traverse relations within these workspaces (shared-pod safety). */
  workspaceIds?: string[];
}): Promise<
  Array<{
    entityId: string;
    depth: number;
    relationshipType: string;
    direction: "outbound" | "inbound";
    path: string[];
  }>
> {
  const {
    userId,
    startEntityId,
    maxDepth = 2,
    relationshipTypes,
    workspaceIds,
  } = params;
  const safeDepth = Math.min(maxDepth, 3);
  const hasWsFilter = workspaceIds && workspaceIds.length > 0;

  const visited = new Set<string>([startEntityId]);
  const results: Array<{
    entityId: string;
    depth: number;
    relationshipType: string;
    direction: "outbound" | "inbound";
    path: string[];
  }> = [];
  let frontier = [{ entityId: startEntityId, depth: 0, path: [startEntityId] }];

  while (frontier.length > 0 && frontier[0].depth < safeDepth) {
    const next: typeof frontier = [];

    for (const node of frontier) {
      let rows: Array<{
        source_entity_id: string;
        target_entity_id: string;
        type: string;
      }>;

      if (relationshipTypes && relationshipTypes.length > 0) {
        rows = hasWsFilter
          ? await sql<typeof rows>`
              SELECT source_entity_id, target_entity_id, type
              FROM relations
              WHERE user_id = ${userId}
                AND type = ANY(${relationshipTypes})
                AND (source_entity_id = ${node.entityId} OR target_entity_id = ${node.entityId})
                AND workspace_id = ANY(${workspaceIds})
              LIMIT 50
            `
          : await sql<typeof rows>`
              SELECT source_entity_id, target_entity_id, type
              FROM relations
              WHERE user_id = ${userId}
                AND type = ANY(${relationshipTypes})
                AND (source_entity_id = ${node.entityId} OR target_entity_id = ${node.entityId})
              LIMIT 50
            `;
      } else {
        rows = hasWsFilter
          ? await sql<typeof rows>`
              SELECT source_entity_id, target_entity_id, type
              FROM relations
              WHERE user_id = ${userId}
                AND (source_entity_id = ${node.entityId} OR target_entity_id = ${node.entityId})
                AND workspace_id = ANY(${workspaceIds})
              LIMIT 50
            `
          : await sql<typeof rows>`
              SELECT source_entity_id, target_entity_id, type
              FROM relations
              WHERE user_id = ${userId}
                AND (source_entity_id = ${node.entityId} OR target_entity_id = ${node.entityId})
              LIMIT 50
            `;
      }

      for (const row of rows) {
        const isOutbound = row.source_entity_id === node.entityId;
        const neighborId = isOutbound
          ? row.target_entity_id
          : row.source_entity_id;

        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          const newPath = [...node.path, neighborId];
          results.push({
            entityId: neighborId,
            depth: node.depth + 1,
            relationshipType: row.type,
            direction: isOutbound ? "outbound" : "inbound",
            path: newPath,
          });
          next.push({
            entityId: neighborId,
            depth: node.depth + 1,
            path: newPath,
          });
        }
      }
    }

    frontier = next;
  }

  return results;
}
