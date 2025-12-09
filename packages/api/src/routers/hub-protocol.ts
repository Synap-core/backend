/**
 * Hub Protocol Routes
 * 
 * Dedicated endpoints for Intelligence Hub to access Data Pod
 * Protected by API key authentication with 'hub-protocol' scopes
 */

import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { scopedProcedure } from '../middleware/api-key-auth.js';
import { db, eq, desc, and } from '@synap/database';
import { chatThreads, conversationMessages, entities } from '@synap/database/schema';

/**
 * Hub Protocol Router
 * 
 * Service-to-service API for Intelligence Hub
 * All routes (except health) require API key with 'hub-protocol.read' or 'hub-protocol.write' scope
 */
export const hubProtocolRouter = router({
  /**
   * Health check (no auth required)
   */
  health: publicProcedure
    .query(() => {
      return { status: 'ok', service: 'hub-protocol' };
    }),
  
  /**
   * Get thread context (messages + metadata)
   * Requires: hub-protocol.read scope
   */
  getThreadContext: scopedProcedure(['hub-protocol.read'])
    .input(z.object({
      threadId: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      // Get thread
      const thread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.threadId),
      });
      
      if (!thread) {
        throw new Error('Thread not found');
      }
      
      // Get messages (last 50)
      const messages = await db.query.conversationMessages.findMany({
        where: eq(conversationMessages.threadId, input.threadId),
        orderBy: [desc(conversationMessages.timestamp)],
        limit: 50,
      });
      
      // Get recent entities for this user
      const recentEntities = await db.query.entities.findMany({
        where: eq(entities.userId, thread.userId),
        orderBy: [desc(entities.createdAt)],
        limit: 10,
      });
      
      return {
        thread: {
          id: thread.id,
          userId: thread.userId,
          projectId: thread.projectId,
          agentId: thread.agentId,
        },
        messages: messages.reverse().map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
        recentEntities: recentEntities.map(e => ({
          id: e.id,
          type: e.type,
          title: e.title,
        })),
      };
    }),
  
  /**
   * Get user context
   * Requires: hub-protocol.read scope
   */
  getUserContext: scopedProcedure(['hub-protocol.read'])
    .input(z.object({
      userId: z.string(),
    }))
    .query(async ({ input }) => {
      // Get recent entities
      const recentEntities = await db.query.entities.findMany({
        where: eq(entities.userId, input.userId),
        orderBy: [desc(entities.createdAt)],
        limit: 20,
      });
      
      // Get recent threads
      const recentThreads = await db.query.chatThreads.findMany({
        where: eq(chatThreads.userId, input.userId),
        orderBy: [desc(chatThreads.updatedAt)],
        limit: 5,
      });
      
      return {
        userId: input.userId,
        preferences: {},
        recentActivity: [
          ...recentEntities.map(e => ({
            type: 'entity_created',
            timestamp: e.createdAt,
            data: { entityId: e.id, entityType: e.type },
          })),
          ...recentThreads.map(t => ({
            type: 'thread_updated',
            timestamp: t.updatedAt,
            data: { threadId: t.id },
          })),
        ].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, 10),
      };
    }),
  
  /**
   * Get entities for user
   * Requires: hub-protocol.read scope
   */
  getEntities: scopedProcedure(['hub-protocol.read'])
    .input(z.object({
      userId: z.string(),
      type: z.string().optional(),
      limit: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, input.userId),
          input.type ? eq(entities.type, input.type) : undefined
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit || 50,
      });
      
      return results;
    }),
  
  /**
   * Create entity
   * Requires: hub-protocol.write scope
   */
  createEntity: scopedProcedure(['hub-protocol.write'])
    .input(z.object({
      userId: z.string(),
      type: z.string(),
      title: z.string(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const [entity] = await db.insert(entities).values({
        userId: input.userId,
        type: input.type,
        title: input.title,
        preview: input.description,
      }).returning();
      
      return entity;
    }),
  
  /**
   * Update thread context
   * Requires: hub-protocol.write scope
   */
  updateThreadContext: scopedProcedure(['hub-protocol.write'])
    .input(z.object({
      threadId: z.string().uuid(),
      contextSummary: z.string(),
    }))
    .mutation(async ({ input }) => {
      await db.update(chatThreads)
        .set({
          contextSummary: input.contextSummary,
          updatedAt: new Date(),
        })
        .where(eq(chatThreads.id, input.threadId));
      
      return { success: true };
    }),
});
