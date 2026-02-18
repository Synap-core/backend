/**
 * Hub Protocol - Linking Router
 *
 * Handles context linking operations (entity/document to thread).
 * These are fast-path operations — no validation or approval needed.
 * Direct DB inserts (like updateThreadContext), not event pipeline.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { db, eq, and } from "@synap/database";
import {
  chatThreads,
  threadEntities,
  threadDocuments,
  ThreadEntityRelationshipType,
  ThreadDocumentRelationshipType,
  ThreadEntityConflictStatus,
  ThreadDocumentConflictStatus,
} from "@synap/database/schema";

const relationshipTypeEnum = z.enum([
  "used_as_context",
  "created",
  "updated",
  "referenced",
  "inherited_from_parent",
]);

export const linkingRouter = router({
  /**
   * Link entity to thread (context tracking)
   * Requires: hub-protocol.write scope
   * Fast-path: Direct DB insert — no event pipeline needed for context tracking.
   * Idempotent: If the same (thread, entity, relationship) already exists, no-op.
   */
  linkEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        threadId: z.string().uuid(),
        entityId: z.string().uuid(),
        relationshipType: relationshipTypeEnum.default("referenced"),
        sourceMessageId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Verify thread exists and get workspaceId
      const thread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.threadId),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Idempotent insert — skip if already linked with same relationship
      const existing = await db.query.threadEntities.findFirst({
        where: and(
          eq(threadEntities.threadId, input.threadId),
          eq(threadEntities.entityId, input.entityId),
          eq(
            threadEntities.relationshipType,
            input.relationshipType as ThreadEntityRelationshipType
          )
        ),
      });

      if (!existing) {
        await db.insert(threadEntities).values({
          threadId: input.threadId,
          entityId: input.entityId,
          relationshipType: input.relationshipType as ThreadEntityRelationshipType,
          userId: input.userId,
          workspaceId: thread.workspaceId ?? "",
          sourceMessageId: input.sourceMessageId,
          conflictStatus: ThreadEntityConflictStatus.NONE,
        });
      }

      return {
        success: true,
        linked: !existing,
        message: existing ? "Already linked" : "Entity linked to thread",
      };
    }),

  /**
   * Link document to thread (context tracking)
   * Requires: hub-protocol.write scope
   * Fast-path: Direct DB insert — no event pipeline needed for context tracking.
   * Idempotent: If the same (thread, document, relationship) already exists, no-op.
   */
  linkDocument: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        threadId: z.string().uuid(),
        documentId: z.string().uuid(),
        relationshipType: relationshipTypeEnum.default("referenced"),
        sourceMessageId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Verify thread exists and get workspaceId
      const thread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.threadId),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Idempotent insert — skip if already linked with same relationship
      const existing = await db.query.threadDocuments.findFirst({
        where: and(
          eq(threadDocuments.threadId, input.threadId),
          eq(threadDocuments.documentId, input.documentId),
          eq(
            threadDocuments.relationshipType,
            input.relationshipType as ThreadDocumentRelationshipType
          )
        ),
      });

      if (!existing) {
        await db.insert(threadDocuments).values({
          threadId: input.threadId,
          documentId: input.documentId,
          relationshipType:
            input.relationshipType as ThreadDocumentRelationshipType,
          userId: input.userId,
          workspaceId: thread.workspaceId ?? "",
          sourceMessageId: input.sourceMessageId,
          conflictStatus: ThreadDocumentConflictStatus.NONE,
        });
      }

      return {
        success: true,
        linked: !existing,
        message: existing ? "Already linked" : "Document linked to thread",
      };
    }),
});
