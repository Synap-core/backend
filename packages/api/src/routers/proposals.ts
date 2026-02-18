/**
 * Universal Proposals Router
 *
 * Handles listing, approving, and rejecting proposals for ALL entity types.
 * Replaces legacy document_proposals logic.
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, proposals, documents, eq, and, desc } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  type StoredProposalData,
  isDocumentContentProposalData,
  isRequestShapedProposalData,
} from "@synap-core/types";
import { storage } from "@synap/storage";
import { requireUserId } from "../utils/user-scoped.js";

export const proposalsRouter = router({
  /**
   * List proposals (Inbox)
   * Can be filtered by workspace, targetType, or specific targetId
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().optional(),
        targetType: z
          .enum(["document", "entity", "whiteboard", "view"])
          .optional(),
        targetId: z.string().optional(),
        status: z
          .enum(["pending", "validated", "rejected", "all"])
          .default("pending"),
        limit: z.number().default(50),
      })
    )
    .query(async ({ input }) => {
      const conditions = [];

      // Filter by Workspace (Security Boundary)
      if (input.workspaceId) {
        conditions.push(eq(proposals.workspaceId, input.workspaceId));
      }

      if (input.targetType) {
        conditions.push(eq(proposals.targetType, input.targetType));
      }

      if (input.targetId) {
        conditions.push(eq(proposals.targetId, input.targetId));
      }

      if (input.status !== "all") {
        // Map string to enum
        const statusEnum =
          input.status === "pending"
            ? ProposalStatus.PENDING
            : input.status === "validated"
              ? ProposalStatus.APPROVED // Note: "validated" maps to APPROVED
              : ProposalStatus.REJECTED;
        conditions.push(eq(proposals.status, statusEnum));
      }

      // TODO: Add stricter permission checks here (User must be Editor of workspace)
      // For now, relying on workspaceId scope.

      const items = await db.query.proposals.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(proposals.createdAt),
        limit: input.limit,
      });

      return { proposals: items };
    }),

  /**
   * Approve a proposal
   * For hub-created document proposals (AI edit): applies proposedContent to storage + DB.
   * For other proposals: emits the original request event as *.validated.
   */
  approve: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        comment: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
      });

      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      const payload = proposal.data as StoredProposalData | null | undefined;

      // B3: Document content proposal (hub/chat/user_edit) – apply content directly
      if (
        proposal.targetType === "document" &&
        isDocumentContentProposalData(payload)
      ) {
        const { storage } = await import("@synap/storage");
        const { documents, documentVersions } =
          await import("@synap/database/schema");

        const document = await db.query.documents.findFirst({
          where: eq(documents.id, proposal.targetId),
        });

        if (!document?.storageKey) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Document not found or has no storage key",
          });
        }

        const newVersion = (document.currentVersion ?? 1) + 1;
        const content = payload.proposedContent;

        await storage.upload(
          document.storageKey,
          Buffer.from(content, "utf-8"),
          { contentType: document.mimeType || "text/plain" }
        );

        await db.insert(documentVersions).values({
          documentId: proposal.targetId,
          version: newVersion,
          content,
          author: "user",
          authorId: userId,
          message: "AI edit accepted",
        });

        await db
          .update(documents)
          .set({
            currentVersion: newVersion,
            lastSavedVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, proposal.targetId));

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        return { success: true };
      }

      // Generic flow: emit validated event (request-shaped data from global-validator / chat)
      if (isRequestShapedProposalData(payload)) {
        const {
          targetType,
          changeType,
          data: requestData,
          requestId,
        } = payload;
        const { inngest } = await import("@synap/jobs");
        const eventName = `${targetType}.${changeType}.validated`;
        const eventPayload =
          typeof requestData === "object" && requestData !== null
            ? { ...requestData }
            : {};
        if (targetType === "entity") {
          if (
            changeType === "update" &&
            eventPayload.entityId != null &&
            eventPayload.id == null
          ) {
            eventPayload.id = eventPayload.entityId;
          }
          if (
            changeType === "create" &&
            eventPayload.description != null &&
            eventPayload.preview == null
          ) {
            eventPayload.preview = eventPayload.description;
          }
        }

        await inngest.send({
          name: eventName,
          data: {
            ...eventPayload,
            workspaceId: proposal.workspaceId,
            approvedBy: userId,
            approvedAt: new Date().toISOString(),
            approvalComment: input.comment,
            requestId,
          },
          user: { id: userId },
        });
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      return { success: true };
    }),

  /**
   * Reject a proposal
   */
  reject: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.REJECTED,
          rejectionReason: input.reason,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      return { success: true };
    }),

  /**
   * Submit a proposal (Universal Request)
   * Emits *.requested event.
   * If user has permission + auto-approve enabled -> Validated.
   * If not -> Pending Proposal.
   */
  submit: protectedProcedure
    .input(
      z.object({
        targetType: z.enum([
          "document",
          "entity",
          "relation",
          "workspace",
          "view",
        ]),
        targetId: z.string().optional(),
        changeType: z.enum(["create", "update", "delete"]),
        data: z.record(z.string(), z.any()),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { randomUUID } = await import("crypto");
      const { emitRequestEvent } = await import("../utils/emit-event.js");
      const requestId = randomUUID();

      // Route through the canonical event pipeline:
      // DB write → event processor → Inngest → GlobalValidator → validated/proposal/denied
      await emitRequestEvent({
        subjectType: input.targetType,
        action: input.changeType,
        subjectId: input.targetId,
        data: {
          ...input.data,
          id: input.targetId,
          requestId,
          reasoning: input.reasoning,
        } as any,
        userId,
        workspaceId: (input.data.workspaceId as string) || undefined,
        source: "api",
        metadata: {
          // Tag as explicit user proposal so downstream (validator, UI) can identify it
          source: "user_proposal",
          submittedBy: userId,
        } as any,
      });

      return {
        success: true,
        requestId,
        status: "requested",
        message: "Proposal submitted for validation",
      };
    }),

  /**
   * Create a document edit proposal (suggest edit): replace text in range [from, to] with replacementText.
   * Used when user selects text and clicks "Suggest edit" in the editor.
   */
  createDocumentEdit: workspaceProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
        replacementText: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace context required",
        });
      }

      const document = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      if (document.workspaceId !== workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Document is not in the current workspace",
        });
      }

      let currentContent: string;
      if (document.storageKey) {
        const contentBuffer = await storage.downloadBuffer(document.storageKey);
        currentContent =
          (document.mimeType?.includes("base64") ?? false)
            ? contentBuffer.toString("base64")
            : contentBuffer.toString("utf-8");
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Document has no stored content (e.g. whiteboard); suggest edit not supported",
        });
      }

      const from = Math.min(input.from, currentContent.length);
      const to = Math.min(input.to, currentContent.length);
      const proposedContent =
        currentContent.slice(0, from) +
        input.replacementText +
        currentContent.slice(to);

      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId,
          targetType: "document",
          targetId: input.documentId,
          proposalType: "user_edit",
          data: {
            proposedContent,
            range: [from, to],
            originalSnippet: currentContent.slice(from, to),
            replacementText: input.replacementText,
          },
          status: ProposalStatus.PENDING,
        })
        .returning();

      if (!proposal) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create proposal",
        });
      }

      return { proposalId: proposal.id };
    }),
});
