/**
 * Hub Protocol - Entities Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same event sourcing,
 * validation, security, and worker infrastructure.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const entitiesRouter = router({
  /**
   * Get entities for user
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's list endpoint internally
   */
  getEntities: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        type: z.string().optional(),
        limit: z.number().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const workspaceId = input.workspaceId ?? (ctx as any).workspaceId ?? null;
      // Use input.userId (the real user) not ctx.userId (the API key owner "system")
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        workspaceId
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      // Call regular API's list endpoint
      const result = await caller.list({
        profileSlug: input.type, // Map type to profileSlug
        limit: input.limit || 50,
      });

      return result.entities;
    }),

  /**
   * Create entity
   * Requires: hub-protocol.write scope
   *
   * Calls regular API's create endpoint internally
   */
  createEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        type: z.string(),
        title: z.string(),
        description: z.string().optional(),
        // agentUserId: the per-human agent user (userType:"agent") acting on behalf of userId.
        // The Intelligence Hub must pass this explicitly — it is NOT the API key owner.
        agentUserId: z.string().uuid().optional(),
        // AI metadata for tracking AI-generated proposals
        aiMetadata: z
          .object({
            messageId: z.string().optional(),
            confidence: z.number().min(0).max(1).optional(),
            model: z.string().optional(),
            reasoning: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Use the real user (input.userId), not ctx.userId (API key owner)
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        ctx.workspaceId ?? undefined,
        ctx.sourceMessageId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.create({
        profileSlug: input.type,
        title: input.title,
        description: input.description,
        // Use "agent" source when agentUserId is present — enables proper attribution in events
        source: input.agentUserId ? "agent" : "intelligence",
        // Prefer explicit agentUserId from request; fall back to API key owner only
        // as last resort (API key owner is a system account, not a per-human agent).
        agentUserId: input.agentUserId ?? ctx.userId ?? undefined,
      });
      return {
        status: result.status,
        message: result.message,
        id: result.id,
        proposalId: result.proposalId,
      };
    }),

  /**
   * Update entity
   * Requires: hub-protocol.write scope
   *
   * Calls regular API's update endpoint internally
   */
  updateEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        entityId: z.string().uuid(),
        userId: z.string(),
        title: z.string().optional(),
        preview: z.string().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Use the real user (input.userId), not ctx.userId (API key owner)
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        ctx.workspaceId ?? undefined,
        ctx.sourceMessageId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.update({
        id: input.entityId,
        title: input.title,
        description: input.preview,
        properties: input.metadata,
        source: input.agentUserId ? "agent" : "intelligence",
        agentUserId: input.agentUserId ?? ctx.userId ?? undefined,
      });

      return {
        status: result.status,
        message: result.message,
        proposalId: result.proposalId,
      };
    }),
});
