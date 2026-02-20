/**
 * Hub Protocol - Documents Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same infrastructure.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { documentsRouter as regularDocumentsRouter } from "../documents.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { db, documents, normalizeDocumentType } from "@synap/database";
import { auditLog } from "../../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";

export const documentsRouter = router({
  /**
   * Create a new document (B4)
   * Requires: hub-protocol.write scope
   * Emits documents.create.requested; returns document id for the agent.
   */
  createDocument: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        title: z.string().min(1),
        content: z.string().default(""),
        type: z
          .enum(["text", "markdown", "code", "pdf", "docx"])
          .default("markdown"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const documentId = randomUUID();
      const userId = input.userId;
      const docType = normalizeDocumentType(input.type, "markdown");
      const extension = docType === "markdown" ? "md" : docType;

      // Upload content to MinIO
      const { storage } = await import("@synap/storage");
      const content = input.content || "";
      const storageKey = storage.buildPath(userId, "document", documentId, extension);
      const metadata = await storage.upload(storageKey, content, {
        contentType: "text/markdown",
      });

      // Insert document into DB
      const [created] = await db
        .insert(documents)
        .values({
          id: documentId,
          title: input.title,
          type: docType,
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/markdown",
          userId,
          workspaceId: input.userId,
          currentVersion: 1,
          lastSavedVersion: 1,
        })
        .returning();

      // Audit + side-effects (fire-and-forget)
      auditLog({
        subjectType: "document",
        action: "create",
        phase: "completed",
        subjectId: documentId,
        userId: ctx.userId!,
        source: "intelligence",
      });

      emitSideEffects({
        subjectType: "document",
        action: "create",
        subjectId: documentId,
        userId: ctx.userId!,
      });

      return { id: created.id, documentId: created.id };
    }),

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
      const { documents, entities, proposals, ProposalStatus } =
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

      const workspaceId = entity?.workspaceId || input.userId; // Projects: Removed projectIds

      // Create proposal in DB
      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId: workspaceId,
          targetType: "document",
          targetId: input.documentId,
          proposalType: input.proposalType,
          data: {
            proposedBy: "ai",
            changes: input.changes,
            originalContent: input.originalContent,
            proposedContent: input.proposedContent,
            expiresAt: expiresAt.toISOString(),
          },
          status: ProposalStatus.PENDING,
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
        requestId: proposal.id, // Return proposalId as requestId for consistency
      };
    }),
});
