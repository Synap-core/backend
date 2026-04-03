/**
 * Hub Protocol - Branches Router
 *
 * AI governance: both createBranch and mergeBranch are significant workspace
 * operations that always require a proposal from an AI agent. The user must
 * approve before any branch is created or merged.
 *
 * Flow:
 *   AI proposes → checkPermissionOrPropose → proposal created (PENDING)
 *   User approves in inbox → proposals.approve → channelsRouter executes
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { TRPCError } from "@trpc/server";
import { db, eq } from "@synap/database";
import { channels } from "@synap/database/schema";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";

export const branchesRouter = router({
  /**
   * Propose creating a branch thread
   * Requires: hub-protocol.write scope
   *
   * AI governance: always creates a pending proposal.
   * "channel.create_branch" is not in the default autoApproveFor whitelist.
   * The user approves in the inbox → branches.approve → channelsRouter.createThread executes.
   */
  createBranch: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        parentChannelId: z.string().uuid(),
        branchPurpose: z.string(),
        agentId: z.string().optional(),
        agentType: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w:.-]+$/)
          .optional(),
        agentConfig: z.record(z.string(), z.unknown()).optional(),
        inheritContext: z.boolean().default(true),
        reasoning: z.string().optional(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Prefer explicit agentUserId from request; API key owner is a system account.
      const agentUserId = input.agentUserId ?? input.userId;

      // Resolve workspaceId from the parent thread
      const parentChannel = await db.query.channels.findFirst({
        where: eq(channels.id, input.parentChannelId),
        columns: { workspaceId: true },
      });

      if (!parentChannel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Parent channel not found",
        });
      }

      const workspaceId = parentChannel.workspaceId ?? undefined;

      // Governance check — branch creation requires proposal by default
      const perm = await checkPermissionOrPropose({
        userId: agentUserId,
        agentUserId,
        workspaceId,
        subjectType: "channel",
        action: "create_branch",
        source: "intelligence",
        reasoning:
          input.reasoning ??
          `AI proposes creating branch: ${input.branchPurpose}`,
        data: {
          parentChannelId: input.parentChannelId,
          branchPurpose: input.branchPurpose,
          agentId: input.agentId,
          agentType: input.agentType,
          agentConfig: input.agentConfig,
          inheritContext: input.inheritContext,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }

      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          channelId: null,
          proposalId: perm.proposalId,
          message: "Branch creation proposed, awaiting approval",
        };
      }

      // Auto-approved (workspace has relaxed governance — unlikely but supported):
      // execute immediately via channelsRouter
      const { channelsRouter } = await import("../channels.js");
      const { createHubProtocolCallerContext } = await import("./utils.js");
      const callerContext = await createHubProtocolCallerContext(
        agentUserId,
        ctx.scopes || [],
        workspaceId
      );
      const caller = channelsRouter.createCaller(callerContext);
      const result = await caller.createChannel({
        parentChannelId: input.parentChannelId,
        branchPurpose: input.branchPurpose,
        agentId: input.agentId,
        agentType: input.agentType,
        agentConfig: input.agentConfig,
        inheritContext: input.inheritContext,
      });

      return {
        status: "created" as const,
        channelId: result.channelId,
        proposalId: null,
        message: "Branch created",
      };
    }),

  /**
   * Propose merging a branch thread
   * Requires: hub-protocol.write scope
   *
   * AI governance: merging is always proposed — the user must always validate
   * a branch merge. "channel.merge" is not in the autoApproveFor whitelist
   * and workspace owners cannot override this (merge is irreversible).
   */
  mergeBranch: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        branchId: z.string().uuid(),
        summary: z.string().optional(),
        reasoning: z.string().optional(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Prefer explicit agentUserId from request; API key owner is a system account.
      const agentUserId = input.agentUserId ?? input.userId;

      // Resolve workspaceId from the branch channel
      const branchChannel = await db.query.channels.findFirst({
        where: eq(channels.id, input.branchId),
        columns: { workspaceId: true },
      });

      if (!branchChannel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Branch not found",
        });
      }

      const workspaceId = branchChannel.workspaceId ?? undefined;

      // Governance check — merge always requires proposal regardless of whitelist
      const perm = await checkPermissionOrPropose({
        userId: agentUserId,
        agentUserId,
        workspaceId,
        subjectType: "channel",
        action: "merge",
        source: "intelligence",
        reasoning:
          input.reasoning ?? "AI proposes merging branch into parent thread",
        data: {
          branchId: input.branchId,
          summary: input.summary,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }

      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Branch merge proposed, awaiting approval",
        };
      }

      // Auto-approved path (should not occur in practice — "channel.merge" is
      // intentionally excluded from any default whitelist, but handled for completeness)
      const { channelsRouter } = await import("../channels.js");
      const { createHubProtocolCallerContext } = await import("./utils.js");
      const callerContext = await createHubProtocolCallerContext(
        agentUserId,
        ctx.scopes || [],
        workspaceId
      );
      const caller = channelsRouter.createCaller(callerContext);
      const result = await caller.mergeBranch({
        branchId: input.branchId,
        summary: input.summary,
      });

      return {
        status: result.status,
        proposalId: null,
        message: result.message || "Branch merged",
      };
    }),
});
