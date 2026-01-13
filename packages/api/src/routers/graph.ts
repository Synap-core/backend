/**
 * Graph Router - Optimized Graph Queries
 *
 * Provides bulk endpoints for efficient graph rendering:
 * - getNode: Entity + all relations + related entity previews
 * - getSubgraph: Multiple entities with their relationships
 * - getPath: Shortest path between two entities
 *
 * These endpoints reduce N+1 queries and improve graph view performance.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, and, or, inArray, desc } from "@synap/database";
import { entities, relations } from "@synap/database/schema";

/**
 * Get a single node with full graph context
 *
 * Returns entity + all relations + related entity previews in one call.
 * Essential for graph view performance.
 */
export const graphRouter = router({
  /**
   * Get entity with all its relationships and related entity previews
   *
   * @example
   * const node = await synap.graph.getNode.query({
   *   entityId: '123',
   *   includeRelatedPreviews: true
   * });
   */
  getNode: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        includeRelations: z.boolean().default(true),
        includeRelatedPreviews: z.boolean().default(true),
        relationTypes: z.array(z.string()).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // 1. Get the entity
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          eq(entities.userId, ctx.userId),
        ),
      });

      if (!entity) {
        throw new Error("Entity not found");
      }

      if (!input.includeRelations) {
        return { entity, relations: [], relatedEntities: [], stats: null };
      }

      // 2. Get all relations for this entity (both directions)
      const whereClause = and(
        eq(relations.userId, ctx.userId),
        or(
          eq(relations.sourceEntityId, input.entityId),
          eq(relations.targetEntityId, input.entityId),
        ),
        input.relationTypes
          ? inArray(relations.type, input.relationTypes)
          : undefined,
      );

      const allRelations = await db.query.relations.findMany({
        where: whereClause,
        orderBy: [desc(relations.createdAt)],
      });

      // 3. Get related entity IDs
      const relatedEntityIds = new Set<string>();
      allRelations.forEach((rel) => {
        if (rel.sourceEntityId === input.entityId) {
          relatedEntityIds.add(rel.targetEntityId);
        } else {
          relatedEntityIds.add(rel.sourceEntityId);
        }
      });

      // 4. Fetch related entity previews if requested
      let relatedEntities: any[] = [];
      if (input.includeRelatedPreviews && relatedEntityIds.size > 0) {
        relatedEntities = await db.query.entities.findMany({
          where: and(
            eq(entities.userId, ctx.userId),
            inArray(entities.id, Array.from(relatedEntityIds)),
          ),
          columns: {
            id: true,
            type: true,
            title: true,
            preview: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      }

      // 5. Calculate statistics
      const outgoing = allRelations.filter(
        (r) => r.sourceEntityId === input.entityId,
      );
      const incoming = allRelations.filter(
        (r) => r.targetEntityId === input.entityId,
      );

      const byType: Record<string, number> = {};
      allRelations.forEach((rel) => {
        byType[rel.type] = (byType[rel.type] || 0) + 1;
      });

      const stats = {
        total: allRelations.length,
        outgoing: outgoing.length,
        incoming: incoming.length,
        byType,
      };

      return {
        entity,
        relations: allRelations,
        relatedEntities,
        stats,
      };
    }),

  /**
   * Get multiple entities with their relationships
   * Useful for rendering a filtered subgraph
   *
   * @example
   * const subgraph = await synap.graph.getSubgraph.query({
   *   entityIds: ['123', '456', '789'],
   * });
   */
  getSubgraph: protectedProcedure
    .input(
      z.object({
        entityIds: z.array(z.string().uuid()).min(1).max(100),
        includeInternalRelations: z.boolean().default(true),
        includeExternalRelations: z.boolean().default(false),
      }),
    )
    .query(async ({ input, ctx }) => {
      // 1. Fetch all requested entities
      const fetchedEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          inArray(entities.id, input.entityIds),
        ),
      });

      if (!input.includeInternalRelations && !input.includeExternalRelations) {
        return { entities: fetchedEntities, relations: [] };
      }

      // 2. Fetch relations
      let relationWhere;

      if (input.includeInternalRelations && !input.includeExternalRelations) {
        // Only relations where BOTH entities are in the set
        relationWhere = and(
          eq(relations.userId, ctx.userId),
          inArray(relations.sourceEntityId, input.entityIds),
          inArray(relations.targetEntityId, input.entityIds),
        );
      } else {
        // Relations where at least ONE entity is in the set
        relationWhere = and(
          eq(relations.userId, ctx.userId),
          or(
            inArray(relations.sourceEntityId, input.entityIds),
            inArray(relations.targetEntityId, input.entityIds),
          ),
        );
      }

      const fetchedRelations = await db.query.relations.findMany({
        where: relationWhere,
        orderBy: [desc(relations.createdAt)],
      });

      return {
        entities: fetchedEntities,
        relations: fetchedRelations,
      };
    }),

  /**
   * Get graph statistics for an entity or entire graph
   */
  getStats: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid().optional(),
        entityType: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      if (input.entityId) {
        // Stats for specific entity
        const relCount = await db
          .select()
          .from(relations)
          .where(
            and(
              eq(relations.userId, ctx.userId),
              or(
                eq(relations.sourceEntityId, input.entityId),
                eq(relations.targetEntityId, input.entityId),
              ),
            ),
          );

        return {
          entityId: input.entityId,
          relationCount: relCount.length,
          outgoing: relCount.filter((r) => r.sourceEntityId === input.entityId)
            .length,
          incoming: relCount.filter((r) => r.targetEntityId === input.entityId)
            .length,
        };
      }

      // Global stats
      const allEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          input.entityType ? eq(entities.type, input.entityType) : undefined,
        ),
      });

      const allRelations = await db.query.relations.findMany({
        where: eq(relations.userId, ctx.userId),
      });

      const typeDistribution: Record<string, number> = {};
      allEntities.forEach((e) => {
        typeDistribution[e.type] = (typeDistribution[e.type] || 0) + 1;
      });

      const relationTypeDistribution: Record<string, number> = {};
      allRelations.forEach((r) => {
        relationTypeDistribution[r.type] =
          (relationTypeDistribution[r.type] || 0) + 1;
      });

      return {
        totalEntities: allEntities.length,
        totalRelations: allRelations.length,
        entityTypeDistribution: typeDistribution,
        relationTypeDistribution,
        averageRelationsPerEntity:
          allEntities.length > 0 ? allRelations.length / allEntities.length : 0,
      };
    }),
});
