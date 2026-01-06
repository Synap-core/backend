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
      workspaceId: z.string().uuid().optional(),
      fileUrl: z.string().optional(),
      filePath: z.string().optional(),
      fileSize: z.number().optional(),
      fileType: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Import dynamically to avoid circular dependency
      const { EntityEvents } = await import('../lib/event-helpers.js');
      const { checkPermission } = await import('../lib/permissions.js');
      
      // 1. Check permission
      if (input.workspaceId) {
        const permission = await checkPermission({
          userId: ctx.userId,
          action: 'create',
          resourceType: 'entity',
          workspaceId: input.workspaceId,
          resourceData: input,
        });
        
        if (!permission.allowed) {
          await EntityEvents.createDenied(ctx.userId, {
            reason: permission.reason || 'Permission denied',
            entityData: input,
          });
          throw new Error(`Permission denied: ${permission.reason}`);
        }
      }
      
      // 2. Emit requested event
      await EntityEvents.createRequested(ctx.userId, {
        type: input.type,
        title: input.title,
        workspaceId: input.workspaceId,
      });
      
      // 3. Persist (no RLS blocks this)
      const [entity] = await db.insert(entities).values({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        type: input.type,
        title: input.title,
        preview: input.description,
        fileUrl: input.fileUrl,
        filePath: input.filePath,
        fileSize: input.fileSize,
        fileType: input.fileType,
      }).returning();
      
      // 4. Emit validated event
      await EntityEvents.createValidated(ctx.userId, {
        id: entity.id,
        type: entity.type,
        title: entity.title!,
      });
      
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
      const { EntityEvents } = await import('../lib/event-helpers.js');
      const { checkPermission } = await import('../lib/permissions.js');
      
      // Get existing entity to check workspace
      const existing = await db.query.entities.findFirst({
        where: eq(entities.id, input.id),
      });
      
      if (!existing) {
        throw new Error('Entity not found');
      }
      
      // Check permission
      if (existing.workspaceId) {
        const permission = await checkPermission({
          userId: ctx.userId,
          action: 'update',
          resourceType: 'entity',
          workspaceId: existing.workspaceId,
        });
        
        if (!permission.allowed) {
          await EntityEvents.updateDenied(ctx.userId, input.id, permission.reason || 'Permission denied');
          throw new Error(`Permission denied: ${permission.reason}`);
        }
      } else if (existing.userId !== ctx.userId) {
        // Personal entity - check ownership
        throw new Error('Not your entity');
      }
      
      // Emit requested event
      await EntityEvents.updateRequested(ctx.userId, input.id, {
        title: input.title,
        preview: input.description,
      });
      
      // Update
      const [updated] = await db.update(entities)
        .set({
          title: input.title,
          preview: input.description,
          updatedAt: new Date(),
          version: sql`version + 1`,
        })
        .where(eq(entities.id, input.id))
        .returning();
      
      // Emit validated event
      await EntityEvents.updateValidated(ctx.userId, input.id, {
        title: updated.title,
        preview: updated.preview,
      });
      
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
      const { EntityEvents } = await import('../lib/event-helpers.js');
      const { checkPermission } = await import('../lib/permissions.js');
      
      // Get existing entity
      const existing = await db.query.entities.findFirst({
        where: eq(entities.id, input.id),
      });
      
      if (!existing) {
        throw new Error('Entity not found');
      }
      
      // Check permission
      if (existing.workspaceId) {
        const permission = await checkPermission({
          userId: ctx.userId,
          action: 'delete',
          resourceType: 'entity',
          workspaceId: existing.workspaceId,
        });
        
        if (!permission.allowed) {
          await EntityEvents.deleteDenied(ctx.userId, input.id, permission.reason || 'Permission denied');
          throw new Error(`Permission denied: ${permission.reason}`);
        }
      } else if (existing.userId !== ctx.userId) {
        throw new Error('Not your entity');
      }
      
      // Emit requested event
      await EntityEvents.deleteRequested(ctx.userId, input.id);
      
      // Soft delete
      await db.update(entities)
        .set({ deletedAt: new Date() })
        .where(eq(entities.id, input.id));
      
      // Emit validated event
      await EntityEvents.deleteValidated(ctx.userId, input.id);
      
      return { success: true };
    }),
});
