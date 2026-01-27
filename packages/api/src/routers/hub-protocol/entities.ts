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
        type: z.string().optional(),
        limit: z.number().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      // Call regular API's list endpoint
      const result = await caller.list({
        type: input.type as any,
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
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      // Call regular API's create endpoint
      // Note: Regular API doesn't have aiMetadata, but we can add it to the event
      const result = await caller.create({
        type: input.type as any,
        title: input.title,
        description: input.description,
      });

      // If aiMetadata was provided, we could emit an additional event
      // or store it separately. For now, the entity is created via regular API.
      return {
        status: result.status,
        message: result.message,
        id: result.id,
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      // Call regular API's update endpoint
      // Note: Regular API doesn't have metadata parameter in update,
      // but we can pass it via workspaceId or extend the API later
      const result = await caller.update({
        id: input.entityId,
        title: input.title,
        preview: input.preview,
      });

      return {
        status: result.status,
        message: result.message,
      };
    }),
});
