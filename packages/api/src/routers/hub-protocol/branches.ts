/**
 * Hub Protocol - Branches Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same event sourcing infrastructure.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { infiniteChatRouter } from "../infinite-chat.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const branchesRouter = router({
  /**
   * Create branch thread
   * Requires: hub-protocol.write scope
   *
   * Calls regular API's createThread endpoint internally
   */
  createBranch: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        parentThreadId: z.string().uuid(),
        branchPurpose: z.string(),
        agentId: z.string().optional(),
        agentType: z
          .enum([
            "default",
            "meta",
            "prompting",
            "knowledge-search",
            "code",
            "writing",
            "action",
          ])
          .optional(),
        agentConfig: z.record(z.string(), z.unknown()).optional(),
        inheritContext: z.boolean().default(true),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = infiniteChatRouter.createCaller(callerContext);

      // Call regular API's createThread endpoint with branch parameters
      const result = await caller.createThread({
        parentThreadId: input.parentThreadId,
        branchPurpose: input.branchPurpose,
        agentId: input.agentId,
        agentType: input.agentType,
        agentConfig: input.agentConfig,
        inheritContext: input.inheritContext,
      });

      return {
        status: result.status,
        threadId: result.threadId,
        message: result.message || "Branch creation requested",
      };
    }),

  /**
   * Merge branch thread
   * Requires: hub-protocol.write scope
   *
   * Calls regular API's mergeBranch endpoint internally
   */
  mergeBranch: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        branchId: z.string().uuid(),
        summary: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = infiniteChatRouter.createCaller(callerContext);

      // Call regular API's mergeBranch endpoint
      const result = await caller.mergeBranch({
        branchId: input.branchId,
        summary: input.summary,
      });

      return {
        status: result.status,
        message: result.message || "Branch merge requested",
      };
    }),
});
