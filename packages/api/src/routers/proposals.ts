/**
 * Universal Proposals Router
 *
 * Handles listing, approving, and rejecting proposals for ALL entity types.
 * Replaces legacy document_proposals logic.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, proposals, eq, and, desc } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
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

      const request = proposal.data as Record<string, unknown>;

      // B3: Hub-created document proposal (AI edit) – apply content directly
      if (
        proposal.targetType === "document" &&
        request &&
        typeof request.proposedContent === "string"
      ) {
        const { storage } = await import("@synap/storage");
        const { documents } = await import("@synap/database/schema");

        const document = await db.query.documents.findFirst({
          where: eq(documents.id, proposal.targetId),
        });

        if (!document?.storageKey) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Document not found or has no storage key",
          });
        }

        await storage.upload(
          document.storageKey,
          Buffer.from(request.proposedContent as string, "utf-8"),
          { contentType: document.mimeType || "text/plain" }
        );

        await db
          .update(documents)
          .set({
            currentVersion: (document.currentVersion ?? 1) + 1,
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

      // Generic flow: emit validated event (requires request.targetType and request.changeType)
      const targetType = request?.targetType as string | undefined;
      const changeType = request?.changeType as string | undefined;

      if (targetType && changeType) {
        const { inngest } = await import("@synap/jobs");
        const eventName = `${targetType}s.${changeType}.validated`;

        await inngest.send({
          name: eventName,
          data: {
            ...(typeof request?.data === "object" && request.data !== null
              ? (request.data as object)
              : {}),
            approvedBy: userId,
            approvedAt: new Date().toISOString(),
            approvalComment: input.comment,
            requestId: (request as any).requestId,
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
      const { inngest } = await import("@synap/jobs");
      const { randomUUID } = await import("crypto");
      const requestId = randomUUID();

      // Construct event name
      // e.g. documents.create.requested
      const subject = `${input.targetType}s`;
      const eventName = `${subject}.${input.changeType}.requested`;

      await inngest.send({
        name: eventName,
        data: {
          ...input.data,
          targetId: input.targetId,
          requestId,
          reasoning: input.reasoning,
          // Metadata for the validator
          metadata: {
            source: "user_proposal", // Explicit proposal
            submittedBy: userId,
          },
        },
        user: { id: userId },
      });

      return {
        success: true,
        requestId,
        status: "requested",
        message: "Proposal submitted for validation",
      };
    }),
});
