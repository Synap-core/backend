/**
 * Relations Router - Relationship Querying
 * 
 * READ operations for entity relationships.
 * WRITE operations (create/delete) go through events.log → relationsWorker
 * 
 * This router provides:
 * - get() - Get relations for an entity
 * - getRelated() - Get related entities
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { db, eq, and, or, desc } from '@synap/database';
import { relations, entities } from '@synap/database/schema';

/**
 * Relation type schema
 */
const RelationTypeSchema = z.enum([
  'assigned_to',
  'mentions',
  'links_to',
  'parent_of',
  'relates_to',
  'tagged_with',
  'created_by',
  'attended_by',
  'depends_on',
  'blocks',
]);

/**
 * Direction schema for relation queries
 */
const DirectionSchema = z.enum(['source', 'target', 'both']).default('both');

export const relationsRouter = router({
  /**
   * Get relations for an entity
   * 
   * Returns relationship records (not the related entities themselves).
   * Use getRelated() to get the actual entities.
   */
  get: protectedProcedure
    .input(z.object({
      entityId: z.string().uuid(),
      type: RelationTypeSchema.optional(),
      direction: DirectionSchema,
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input, ctx }) => {
      // Build where clause based on direction
      let whereClause;
      
      if (input.direction === 'both') {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          or(
            eq(relations.sourceEntityId, input.entityId),
            eq(relations.targetEntityId, input.entityId)
          ),
          input.type ? eq(relations.type, input.type) : undefined
        );
      } else if (input.direction === 'source') {
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
    .input(z.object({
      entityId: z.string().uuid(),
      type: RelationTypeSchema.optional(),
      direction: DirectionSchema,
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input, ctx }) => {
      // Get relations first
      let relationRecords;
      
      if (input.direction === 'both') {
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
      } else if (input.direction === 'source') {
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
      const relatedEntityIds = relationRecords.map(rel => {
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
          or(...relatedEntityIds.map(id => eq(entities.id, id)))
        ),
      });
      
      return { entities: relatedEntities };
    }),
  
  /**
   * Get relation statistics for an entity
   */
  getStats: protectedProcedure
    .input(z.object({
      entityId: z.string().uuid(),
    }))
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
      allRelations.forEach(rel => {
        byType[rel.type] = (byType[rel.type] || 0) + 1;
      });
      
      return {
        total: allRelations.length,
        outgoing: allRelations.filter(r => r.sourceEntityId === input.entityId).length,
        incoming: allRelations.filter(r => r.targetEntityId === input.entityId).length,
        byType,
      };
    }),
});
