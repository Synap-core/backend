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
      }),
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
        conditions.push(eq(proposals.status, input.status));
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
   * Emits the original request event as *.validated
   */
  approve: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        comment: z.string().optional(),
      }),
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

      // 1. Emit the VALIDATED event
      // We reconstruct the event from the stored request
      const request = proposal.request as any;
      const { inngest } = await import("@synap/jobs");

      // Construct event name: e.g. "documents.create.validated"
      const eventName = `${request.targetType}s.${request.changeType}.validated`;

      await inngest.send({
        name: eventName,
        data: {
          ...request.data, // original payload
          // Inject approval metadata
          approvedBy: userId,
          approvedAt: new Date().toISOString(),
          approvalComment: input.comment,
          requestId: request.requestId, // Maintain trace
        },
        user: { id: userId },
      });

      // 2. Mark proposal as validated (archived)
      await db
        .update(proposals)
        .set({
          status: "validated",
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        } as any)
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      await db
        .update(proposals)
        .set({
          status: "rejected",
          rejectionReason: input.reason,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        } as any)
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
        data: z.record(z.any()),
        reasoning: z.string().optional(),
      }),
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
