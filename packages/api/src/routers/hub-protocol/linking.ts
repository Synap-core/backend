/**
 * Hub Protocol - Linking Router
 *
 * Handles context linking operations (entity/document to thread)
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { db, eq } from "@synap/database";
import { chatThreads } from "@synap/database/schema";

export const linkingRouter = router({
  /**
   * Link entity to thread (context tracking)
   * Requires: hub-protocol.write scope
   * Fast-path: No validation needed (read-only context tracking)
   */
  linkEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        threadId: z.string().uuid(),
        entityId: z.string().uuid(),
        relationshipType: z
          .enum([
            "used_as_context",
            "created",
            "updated",
            "referenced",
            "inherited_from_parent",
          ])
          .default("referenced"),
        sourceMessageId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { emitRequestEvent } = await import("../../utils/emit-event.js");

      // Get thread to find workspaceId
      const thread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.threadId),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Fast-path event (no validation needed)
      await emitRequestEvent({
        type: "thread_entities.link.requested",
        subjectId: input.threadId,
        subjectType: "chat_thread",
        data: {
          threadId: input.threadId,
          entityId: input.entityId,
          relationshipType: input.relationshipType,
          sourceMessageId: input.sourceMessageId,
          userId: input.userId,
          workspaceId: thread.projectId || input.userId,
        },
        userId: input.userId,
        workspaceId: thread.projectId || undefined,
      });

      return {
        status: "requested",
        message: "Entity link requested",
      };
    }),

  /**
   * Link document to thread (context tracking)
   * Requires: hub-protocol.write scope
   * Fast-path: No validation needed (read-only context tracking)
   */
  linkDocument: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        threadId: z.string().uuid(),
        documentId: z.string().uuid(),
        relationshipType: z
          .enum([
            "used_as_context",
            "created",
            "updated",
            "referenced",
            "inherited_from_parent",
          ])
          .default("referenced"),
        sourceMessageId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { emitRequestEvent } = await import("../../utils/emit-event.js");

      // Get thread to find workspaceId
      const thread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.threadId),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Fast-path event (no validation needed)
      await emitRequestEvent({
        type: "thread_documents.link.requested",
        subjectId: input.threadId,
        subjectType: "chat_thread",
        data: {
          threadId: input.threadId,
          documentId: input.documentId,
          relationshipType: input.relationshipType,
          sourceMessageId: input.sourceMessageId,
          userId: input.userId,
          workspaceId: thread.projectId || input.userId,
        },
        userId: input.userId,
        workspaceId: thread.projectId || undefined,
      });

      return {
        status: "requested",
        message: "Document link requested",
      };
    }),
});
