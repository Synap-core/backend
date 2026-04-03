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
import { TRPCError } from "@trpc/server";
import { documentsRouter as regularDocumentsRouter } from "../documents.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { db, documents, normalizeDocumentType } from "@synap/database";
import { auditLog } from "../../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";

export const documentsRouter = router({
  /**
   * Create a new document (B4)
   * Requires: hub-protocol.write scope
   *
   * AI governance: always goes through checkPermissionOrPropose.
   * If not whitelisted (default): creates a pending proposal with content stored
   * in JSONB — no MinIO write until the user approves.
   * If auto-approved: writes to MinIO and DB immediately.
   */
  createDocument: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        title: z.string().min(1),
        content: z.string().default(""),
        type: z
          .enum(["text", "markdown", "code", "pdf", "docx"])
          .default("markdown"),
        reasoning: z.string().optional(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const documentId = randomUUID();
      // Prefer explicit agentUserId from request; API key owner is a system account.
      const agentUserId = input.agentUserId ?? input.userId;

      // Governance check — AI agent creating a document requires proposal by default
      const perm = await checkPermissionOrPropose({
        userId: agentUserId,
        agentUserId,
        workspaceId: input.workspaceId,
        subjectType: "document",
        action: "create",
        source: "intelligence",
        reasoning: input.reasoning,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        data: {
          id: documentId,
          title: input.title,
          type: input.type,
          // Content stored inline — written to MinIO only when approved
          content: input.content,
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }

      if ("proposalId" in perm) {
        // Not auto-approved: content is stored in proposal JSONB.
        // MinIO upload happens in proposals.approve when the user accepts.
        return {
          id: documentId,
          documentId,
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Document creation proposed, awaiting approval",
        };
      }

      // Auto-approved (matches workspace autoApproveFor whitelist):
      // write to MinIO and DB immediately.
      const { storage } = await import("@synap/storage");
      const docType = normalizeDocumentType(input.type, "markdown");
      const extension = docType === "markdown" ? "md" : docType;
      const content = input.content || "";
      const storageKey = storage.buildPath(
        input.userId,
        "document",
        documentId,
        extension
      );
      const metadata = await storage.upload(storageKey, content, {
        contentType: "text/markdown",
      });

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
          userId: input.userId,
          workspaceId: input.workspaceId,
          currentVersion: 1,
          lastSavedVersion: 1,
        })
        .returning();

      auditLog({
        subjectType: "document",
        action: "create",
        phase: "completed",
        subjectId: documentId,
        userId: agentUserId,
        source: input.agentUserId ? "agent" : "intelligence",
      });

      emitSideEffects({
        subjectType: "document",
        action: "create",
        subjectId: documentId,
        userId: agentUserId,
      });

      return {
        id: created.id,
        documentId: created.id,
        status: "created" as const,
      };
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
   * Create document proposal (for AI edits to existing documents)
   * Requires: hub-protocol.write scope
   *
   * Specialized Hub Protocol operation for AI-generated edit proposals on
   * existing documents. Creates a pending proposal that the user reviews.
   * This is intentionally direct (creating the proposal IS the governed action).
   */
  createDocumentProposal: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
        agentUserId: z.string().uuid().optional(),
        threadId: z.string().uuid().optional(),
        sourceMessageId: z.string().uuid().optional(),
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
    .mutation(async ({ input, ctx }) => {
      const { db, eq } = await import("@synap/database");
      const { documents, entities, proposals, ProposalStatus } =
        await import("@synap/database/schema");

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });

      if (!doc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      const entity = await db.query.entities.findFirst({
        where: eq(entities.documentId, input.documentId),
      });

      const workspaceId = entity?.workspaceId || input.userId;

      const createdBy = input.agentUserId ?? input.userId;
      const sourceMessageId =
        input.sourceMessageId ?? ctx.sourceMessageId ?? undefined;
      const threadId = input.threadId ?? undefined;

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
          createdBy,
          ...(threadId ? { threadId } : {}),
          ...(sourceMessageId ? { sourceMessageId } : {}),
        })
        .returning();

      const { broadcastSuccess } = await import("@synap/jobs");
      await broadcastSuccess(input.userId, "ai:proposal", {
        proposalId: proposal.id,
        operation: "create",
      });

      return {
        status: "proposed",
        proposalId: proposal.id,
        message: "Document edit proposed, awaiting approval",
        requestId: proposal.id,
      };
    }),
});
