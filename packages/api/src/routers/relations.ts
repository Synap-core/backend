/**
 * Relations Router - Relationship Querying
 *
 * Full CRUD operations for entity relationships.
 * CREATE and DELETE operations go through event flow (requested → validated → completed)
 * READ operations query the database directly
 *
 * This router provides:
 * - get() - Get relations for an entity
 * - getRelated() - Get related entities
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, and, or, desc } from "@synap/database";
import { relations, entities } from "@synap/database/schema";
import { emitRequestEvent } from "../utils/emit-event.js";
import { randomUUID } from "crypto";

/**
 * Relation type schema
 *
 * NOTE: Relations are created via event sourcing (events.log → relationsWorker)
 * The insertRelationSchema from database is available if direct creation is needed:
 * insertRelationSchema.pick({ sourceEntityId, targetEntityId, type, ... })
 */
const RelationTypeSchema = z.enum([
  "assigned_to",
  "mentions",
  "links_to",
  "parent_of",
  "relates_to",
  "tagged_with",
  "created_by",
  "attended_by",
  "depends_on",
  "blocks",
]);

/**
 * Direction schema for relation queries
 */
const DirectionSchema = z.enum(["source", "target", "both"]).default("both");

export const relationsRouter = router({
  /**
   * Get relations for an entity
   *
   * Returns relationship records (not the related entities themselves).
   * Use getRelated() to get the actual entities.
   */
  get: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        type: RelationTypeSchema.optional(),
        direction: DirectionSchema,
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      // Build where clause based on direction
      let whereClause;

      if (input.direction === "both") {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          or(
            eq(relations.sourceEntityId, input.entityId),
            eq(relations.targetEntityId, input.entityId)
          ),
          input.type ? eq(relations.type, input.type) : undefined
        );
      } else if (input.direction === "source") {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          eq(relations.sourceEntityId, input.entityId),
          input.type ? eq(relations.type, input.type) : undefined
        );
      } else {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          eq(relations.targetEntityId, input.entityId),
          input.type ? eq(relations.type, input.type) : undefined
        );
      }

      const results = await db.query.relations.findMany({
        where: whereClause,
        orderBy: [desc(relations.createdAt)],
        limit: input.limit,
      });

      return { relations: results };
    }),

  /**
   * Get related entities
   *
   * Returns the actual entity objects that are related,
   * not just the relationship records.
   */
  getRelated: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        type: RelationTypeSchema.optional(),
        direction: DirectionSchema,
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      // Get relations first
      let relationRecords;

      if (input.direction === "both") {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            or(
              eq(relations.sourceEntityId, input.entityId),
              eq(relations.targetEntityId, input.entityId)
            ),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      } else if (input.direction === "source") {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            eq(relations.sourceEntityId, input.entityId),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      } else {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            eq(relations.targetEntityId, input.entityId),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      }

      // Extract entity IDs (the "other" entity in each relation)
      const relatedEntityIds = relationRecords.map((rel) => {
        return rel.sourceEntityId === input.entityId
          ? rel.targetEntityId
          : rel.sourceEntityId;
      });

      if (relatedEntityIds.length === 0) {
        return { entities: [] };
      }

      // Fetch the actual entities
      const relatedEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          or(...relatedEntityIds.map((id) => eq(entities.id, id)))
        ),
      });

      return { entities: relatedEntities };
    }),
  /**
  /**
   * Get relation statistics for an entity
   */
  getStats: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const allRelations = await db.query.relations.findMany({
        where: and(
          eq(relations.userId, ctx.userId),
          or(
            eq(relations.sourceEntityId, input.entityId),
            eq(relations.targetEntityId, input.entityId)
          )
        ),
      });

      // Count by type
      const byType: Record<string, number> = {};
      allRelations.forEach((rel) => {
        byType[rel.type] = (byType[rel.type] || 0) + 1;
      });

      return {
        total: allRelations.length,
        outgoing: allRelations.filter(
          (r) => r.sourceEntityId === input.entityId
        ).length,
        incoming: allRelations.filter(
          (r) => r.targetEntityId === input.entityId
        ).length,
        byType,
      };
    }),

  /**
   * Create a new relation between entities
   */
  create: protectedProcedure
    .input(
      z.object({
        sourceEntityId: z.string().uuid(),
        targetEntityId: z.string().uuid(),
        type: RelationTypeSchema,
        metadata: z.record(z.any()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();

      await emitRequestEvent({
        type: "relations.create.requested",
        subjectId: id,
        subjectType: "relation",
        data: {
          id,
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          type: input.type,
          metadata: input.metadata,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        id,
        status: "requested",
        message: "Relation creation requested",
      };
    }),

  /**
   * Delete a relation
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        type: "relations.delete.requested",
        subjectId: input.id,
        subjectType: "relation",
        data: {
          id: input.id,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Relation deletion requested",
      };
    }),
});
