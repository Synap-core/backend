/**
 * Hub Protocol - Context Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same infrastructure.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { infiniteChatRouter } from "../infinite-chat.js";
import { entitiesRouter } from "../entities.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const contextRouter = router({
  /**
   * Get thread context (messages + metadata)
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's getThread and getMessages endpoints internally
   */
  getThreadContext: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        threadId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const chatCaller = infiniteChatRouter.createCaller(callerContext);
      const entitiesCaller = entitiesRouter.createCaller(callerContext);

      // Get thread with context
      const threadResult = await chatCaller.getThread({
        threadId: input.threadId,
        includeContext: true,
        includeBranches: false,
      });

      // Get messages
      const messagesResult = await chatCaller.getMessages({
        threadId: input.threadId,
        limit: 50,
      });

      // Get recent entities for this user
      const entitiesResult = await entitiesCaller.list({
        limit: 10,
      });

      return {
        thread: {
          id: threadResult.thread.id,
          userId: threadResult.thread.userId,
          projectId: threadResult.thread.projectId || undefined,
          agentId: threadResult.thread.agentId || undefined,
        },
        messages: messagesResult.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
        recentEntities: entitiesResult.entities.slice(0, 10).map((e) => ({
          id: e.id,
          type: e.type,
          title: e.title || null,
        })),
      };
    }),

  /**
   * Get user context
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's list endpoints internally
   */
  getUserContext: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const chatCaller = infiniteChatRouter.createCaller(callerContext);
      const entitiesCaller = entitiesRouter.createCaller(callerContext);

      // Get recent entities
      const entitiesResult = await entitiesCaller.list({
        limit: 20,
      });

      // Get recent threads
      const threadsResult = await chatCaller.listThreads({
        limit: 5,
      });

      return {
        userId: input.userId,
        preferences: {},
        recentActivity: [
          ...entitiesResult.entities.map((e) => ({
            type: "entity_created",
            timestamp: e.createdAt,
            data: { entityId: e.id, entityType: e.type },
          })),
          ...threadsResult.threads.map((t) => ({
            type: "thread_updated",
            timestamp: t.updatedAt,
            data: { threadId: t.id },
          })),
        ]
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, 10),
      };
    }),

  /**
   * Update thread context
   * Requires: hub-protocol.write scope
   *
   * Note: Regular API's updateThread doesn't have contextSummary parameter.
   * This is a specialized Hub Protocol operation, so we keep direct DB update
   * but it's a simple metadata update (not a state change).
   */
  updateThreadContext: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        threadId: z.string().uuid(),
        contextSummary: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      // This is a simple metadata update (contextSummary is not part of event sourcing)
      // We could extend the regular API to support this, but for now we keep it direct
      // since it's a specialized Hub Protocol operation
      const { db, eq } = await import("@synap/database");
      const { chatThreads } = await import("@synap/database/schema");

      await db
        .update(chatThreads)
        .set({
          contextSummary: input.contextSummary,
          updatedAt: new Date(),
        })
        .where(eq(chatThreads.id, input.threadId));

      return { success: true };
    }),
});
