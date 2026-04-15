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
import { db, workspaceMembers, eq } from "@synap/database";

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
      const workspaceId =
        input.workspaceId ??
        ((ctx as Record<string, unknown>).workspaceId as string | null) ??
        null;
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
        // profileSlug is canonical; type is a deprecated alias accepted for backward compat
        profileSlug: z.string().optional(),
        type: z.string().optional(),
        title: z.string(),
        description: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        agentUserId: z.string().uuid().optional(),
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
      // Use the real user (input.userId), not ctx.userId (API key owner).
      //
      // workspaceProcedure (used by entities.create) requires a non-null workspaceId
      // for its auth gate. Pod-scoped profiles (bookmark, note, task, …) have no
      // workspace but still need the gate to pass — so we resolve the user's first
      // accessible workspace for auth purposes only. The mutation itself determines
      // the entity's actual workspaceId from the profile's entityScope (null for pod).
      let authWorkspaceId: string | undefined = ctx.workspaceId ?? undefined;
      if (!authWorkspaceId) {
        const rows = await db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, input.userId))
          .limit(1);
        authWorkspaceId = rows[0]?.workspaceId;
      }

      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        authWorkspaceId,
        ctx.sourceMessageId ?? undefined
      );
      const caller = regularEntitiesRouter.createCaller(callerContext);

      const result = await caller.create({
        profileSlug: input.profileSlug ?? input.type,
        title: input.title,
        description: input.description,
        properties: input.properties,
        // Use "agent" source when agentUserId is present — enables proper attribution in events
        source: input.agentUserId ? "agent" : "intelligence",
        // Only pass agentUserId when explicitly provided — ctx.userId is the API key
        // owner ("system") which is not a valid UUID and would fail Zod validation.
        agentUserId: input.agentUserId,
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
        agentUserId: input.agentUserId,
      });

      return {
        status: result.status,
        message: result.message,
        proposalId: result.proposalId,
      };
    }),
});
