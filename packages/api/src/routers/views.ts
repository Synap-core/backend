/**
 * Views Router - Extensible view system
 * 
 * Handles:
 * - View CRUD (whiteboards, timelines, kanban, etc.)
 * - Content loading/saving
 * - Integration with documents table
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { db, eq, and, desc } from '@synap/database';
import { views, documents, documentVersions, workspaceMembers } from '@synap/database/schema';
import { TRPCError } from '@trpc/server';
import { ViewEvents } from '../lib/event-helpers.js';

export const viewsRouter = router({
  /**
   * Create a new view
   */
  create: protectedProcedure
    .input(z.object({
      workspaceId: z.string().uuid().optional(),
      type: z.enum(['whiteboard', 'timeline', 'kanban', 'table', 'mindmap', 'graph']),
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      initialContent: z.any().optional(), // Tldraw state, timeline config, etc.
    }))
    .mutation(async ({ input, ctx }) => {
      // If workspace provided, check user has access
      if (input.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });

        if (!membership || membership.role === 'viewer') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
      }
      
      // Log requested event
      await ViewEvents.createRequested(ctx.userId, {
        type: input.type,
        name: input.name,
        workspaceId: input.workspaceId || '',
      });

      // Create document for content storage
      const [doc] = await db.insert(documents).values({
        userId: ctx.userId,
        type: input.type,
        title: input.name,
        storageUrl: '', // Will be populated if needed
        storageKey: `views/${input.type}/${Date.now()}`,
        size: 0,
        currentVersion: 1,
      }).returning();

      // Create initial version with content
      await db.insert(documentVersions).values({
        documentId: doc.id,
        version: 1,
        content: JSON.stringify(input.initialContent || {}),
        author: 'user',
        authorId: ctx.userId,
        message: 'Initial version',
      });

      // Create view
      const [view] = await db.insert(views).values({
        workspaceId: input.workspaceId,
        userId: ctx.userId,
        type: input.type,
        name: input.name,
        description: input.description,
        documentId: doc.id,
        metadata: {
          entityCount: 0,
          createdBy: ctx.userId,
        },
      }).returning();
      
      // Log validated event
      await ViewEvents.createValidated(ctx.userId, {
        id: view.id,
        type: view.type,
        name: view.name,
        documentId: doc.id,
      });

      return { view, documentId: doc.id };
    }),

  /**
   * List views
   */
  list: protectedProcedure
    .input(z.object({
      workspaceId: z.string().uuid().optional(),
      type: z.enum(['whiteboard', 'timeline', 'kanban', 'table', 'mindmap', 'graph', 'all']).optional(),
    }))
    .query(async ({ input, ctx }) => {
      let query = db.query.views.findMany({
        where: and(
          eq(views.userId, ctx.userId),
          input.workspaceId ? eq(views.workspaceId, input.workspaceId) : undefined,
          input.type && input.type !== 'all' ? eq(views.type, input.type) : undefined
        ),
        orderBy: [desc(views.updatedAt)],
      });

      return await query;
    }),

  /**
   * Get view with content
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'View not found' });
      }

      // Check access
      if (view.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, view.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });

        if (!membership) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
      } else if (view.userId !== ctx.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }

      // Load content from latest document version
      let content = {};
      if (view.documentId) {
        const latestVersion = await db.query.documentVersions.findFirst({
          where: eq(documentVersions.documentId, view.documentId),
          orderBy: [desc(documentVersions.version)],
        });
        if (latestVersion) {
          try {
            content = JSON.parse(latestVersion.content);
          } catch (e) {
            content = {};
          }
        }
      }

      return { view, content };
    }),

  /**
   * Save view content
   */
  save: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      content: z.any(), // New Tldraw state, timeline config, etc.
      metadata: z.record(z.any()).optional(), // Update metadata
    }))
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'View not found' });
      }

      // Check access (editor+)
      if (view.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, view.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });

        if (!membership || membership.role === 'viewer') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
      } else if (view.userId !== ctx.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }

      // Create new version with updated content
      if (view.documentId) {
        // Get current version number
        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, view.documentId),
        });

        const newVersion = (doc?.currentVersion || 0) + 1;

        // Insert new version
        await db.insert(documentVersions).values({
          documentId: view.documentId,
          version: newVersion,
          content: JSON.stringify(input.content),
          author: 'user',
          authorId: ctx.userId,
          message: 'Auto-save',
        });

        // Update document current version
        await db.update(documents)
          .set({
            currentVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, view.documentId));
      }

      // Update view metadata
      await db.update(views)
        .set({
          metadata: input.metadata,
          updatedAt: new Date(),
        })
        .where(eq(views.id, input.id));

      return { success: true };
    }),

  /**
   * Update view metadata (name, description)
   */
  update: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'View not found' });
      }

      // Check access
      if (view.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, view.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });

        if (!membership || membership.role === 'viewer') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
      } else if (view.userId !== ctx.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }

      const [updated] = await db.update(views)
        .set({
          name: input.name,
          description: input.description,
          updatedAt: new Date(),
        })
        .where(eq(views.id, input.id))
        .returning();

      return updated;
    }),

  /**
   * Delete view
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'View not found' });
      }

      // Check access (owner or admin+)
      if (view.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, view.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });

        if (!membership || !['owner', 'admin', 'editor'].includes(membership.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
      } else if (view.userId !== ctx.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }

      // Delete view (document will be set to null due to onDelete: 'set null')
      await db.delete(views).where(eq(views.id, input.id));

      // Optionally delete document too
      if (view.documentId) {
        await db.delete(documents).where(eq(documents.id, view.documentId));
      }

      return { success: true };
    }),
});
