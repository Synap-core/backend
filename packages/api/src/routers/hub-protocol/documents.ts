/**
 * Hub Protocol - Documents Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same infrastructure.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { documentsRouter as regularDocumentsRouter } from "../documents.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const documentsRouter = router({
  /**
   * Get document content by ID
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's documents.get endpoint internally
   */
  getDocument: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularDocumentsRouter.createCaller(callerContext);

      // Call regular API's get endpoint
      const result = await caller.get({
        documentId: input.documentId,
      });

      return {
        document: {
          id: result.document.id,
          title: result.document.title,
          type: result.document.type,
          language: result.document.language,
          content: result.content,
          updatedAt: result.document.updatedAt,
          createdAt: result.document.createdAt,
        },
      };
    }),

  /**
   * Create document proposal (for AI edits)
   * Requires: hub-protocol.write scope
   *
   * Note: Regular API doesn't have a direct proposal creation endpoint.
   * This is a specialized Hub Protocol operation for AI-generated proposals.
   * We keep it as-is since it's a specialized use case, but it uses the same
   * proposals table and follows the same proposal system.
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
      // This is a specialized Hub Protocol operation for AI proposals
      // It uses the same proposals system but with AI-specific metadata
      // We keep it direct since it's a specialized use case
      const { db, eq } = await import("@synap/database");
      const { documents, entities, proposals } =
        await import("@synap/database/schema");

      // Calculate expiration (7 days)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

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
