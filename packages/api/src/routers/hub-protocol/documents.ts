/**
 * Hub Protocol - Documents Router
 *
 * Handles document operations (get, proposals)
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { db, eq, and } from "@synap/database";
import { documents, entities, proposals } from "@synap/database/schema";

export const documentsRouter = router({
  /**
   * Get document content by ID
   * Requires: hub-protocol.read scope
   */
  getDocument: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
      })
    )
    .query(async ({ input }) => {
      const { storage } = await import("@synap/storage");

      // Get document metadata
      const document = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, input.documentId),
          eq(documents.userId, input.userId)
        ),
      });

      if (!document) {
        throw new Error("Document not found");
      }

      // Fetch content from storage
      const contentBuffer = await storage.downloadBuffer(document.storageKey);
      const content =
        document.type === "pdf" || document.type === "docx"
          ? contentBuffer.toString("base64")
          : contentBuffer.toString("utf-8");

      return {
        document: {
          id: document.id,
          title: document.title,
          type: document.type,
          language: document.language,
          content,
          updatedAt: document.updatedAt,
          createdAt: document.createdAt,
        },
      };
    }),

  /**
   * Create document proposal (for AI edits)
   * Requires: hub-protocol.write scope
   */
  createDocumentProposal: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
        proposalType: z
          .enum(["ai_edit", "user_suggestion", "review_comment"])
          .default("ai_edit"),
        changes: z.array(
          z.object({
            op: z.enum(["insert", "delete", "replace"]),
            position: z.number().optional(),
            range: z.tuple([z.number(), z.number()]).optional(),
            text: z.string().optional(),
          })
        ),
        proposedContent: z.string(),
        originalContent: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Calculate expiration (7 days)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      // Create proposal in DB
      // Verify document exists and get scope
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });

      if (!doc) {
        throw new Error("Document not found");
      }

      // Try to find context (workspace) via entity
      const entity = await db.query.entities.findFirst({
        where: eq(entities.documentId, input.documentId),
      });

      const workspaceId = entity?.workspaceId || doc.projectId || input.userId;

      // Create proposal in DB
      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId: workspaceId,
          targetType: "document",
          targetId: input.documentId,
          request: {
            proposalType: input.proposalType,
            proposedBy: "ai",
            changes: input.changes,
            originalContent: input.originalContent,
            proposedContent: input.proposedContent,
            expiresAt: expiresAt.toISOString(),
          },
          status: "pending",
        })
        .returning();

      // Broadcast to user (real-time notification)
      const { broadcastSuccess } = await import("@synap/jobs");
      await broadcastSuccess(input.userId, "ai:proposal", {
        proposalId: proposal.id,
        operation: "create",
      });

      return {
        status: "proposed",
        proposalId: proposal.id,
        message: "Document edit proposed, awaiting approval",
      };
    }),
});
