/**
 * Entities Router - Enhanced for infinite chat
 * 
 * Handles entity management with agent extraction
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { db, eq, desc, and, sqlDrizzle as sql } from '@synap/database';
import { entities } from '@synap/database/schema';

const EntityTypeSchema = z.enum(['task', 'contact', 'meeting', 'idea', 'note', 'project']);

export const entitiesRouter = router({
  /**
   * Create entity (manual or agent-extracted)
   */
  create: protectedProcedure
    .input(z.object({
      type: EntityTypeSchema,
      title: z.string(),
      description: z.string().optional(),
      fileUrl: z.string().optional(),
      filePath: z.string().optional(),
      fileSize: z.number().optional(),
      fileType: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const [entity] = await db.insert(entities).values({
        userId: ctx.userId,
        type: input.type,
        title: input.title,
        preview: input.description,
        fileUrl: input.fileUrl,
        filePath: input.filePath,
        fileSize: input.fileSize,
        fileType: input.fileType,
      }).returning();
      
      return { entity };
    }),
  
  /**
   * List entities
   */
  list: protectedProcedure
    .input(z.object({
      type: EntityTypeSchema.optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input, ctx }) => {
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          input.type ? eq(entities.type, input.type) : undefined,
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });
      
      return { entities: results };
    }),
  
  /**
   * Search entities (vector + text)
   */
  search: protectedProcedure
    .input(z.object({
      query: z.string(),
      type: EntityTypeSchema.optional(),
      limit: z.number().min(1).max(50).default(10),
    }))
    .query(async ({ input, ctx }) => {
      // Simple text search for now
      // TODO: Implement vector search with pgvector
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          input.type ? eq(entities.type, input.type) : undefined,
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });
      
      return { entities: results };
    }),
  
  /**
   * Get entity by ID
   */
  get: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId)
        ),
      });
      
      if (!entity) {
        throw new Error('Entity not found');
      }
      
      return { entity };
    }),
  
  /**
   * Update entity
   */
  update: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      title: z.string().optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const [updated] = await db.update(entities)
        .set({
          title: input.title,
          preview: input.description,
          updatedAt: new Date(),
          version: sql`version + 1`,
        })
        .where(and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId)
        ))
        .returning();
      
      if (!updated) {
        throw new Error('Entity not found');
      }
      
      return { entity: updated };
    }),
  
  /**
   * Delete entity (soft delete)
   */
  delete: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ input, ctx }) => {
      await db.update(entities)
        .set({ deletedAt: new Date() })
        .where(and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId)
        ));
      
      return { success: true };
    }),
});
