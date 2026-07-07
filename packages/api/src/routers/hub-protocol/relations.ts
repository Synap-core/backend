/**
 * Hub Protocol - Relations Router
 *
 * Exposes entity relationship management to Intelligence Hub agents.
 * Relations connect entities with typed links (assigned_to, depends_on, etc.)
 *
 * Governance:
 *   - listRelations:   auto-approved (read)
 *   - createRelation:  generates proposal (semantic graph change)
 *   - deleteRelation:  generates proposal (irreversible structural change)
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { relationsRouter as regularRelationsRouter } from "../relations.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const hubRelationsRouter = router({
  /**
   * List relations for an entity (or all relations in a workspace)
   * Requires: hub-protocol.read scope
   */
  listRelations: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        entityId: z.string().uuid().optional(),
        type: z.string().optional(),
        limit: z.number().min(1).max(200).default(100),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId
      );
      const caller = regularRelationsRouter.createCaller(callerContext);

      if (input.entityId) {
        // getRelated returns related entities for a specific entity
        const result = await caller.getRelated({
          entityId: input.entityId,
          type: input.type,
          direction: "both",
          limit: input.limit,
        });
        return result;
      }

      // List all relations in workspace
      const result = await caller.list({
        type: input.type,
        limit: input.limit,
      });
      return result;
    }),

  /**
   * Create a relation between two entities
   * Requires: hub-protocol.write scope
   * Governance: generates a proposal (relation mutations are semantic; user should approve)
   */
  createRelation: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        sourceEntityId: z.string().uuid(),
        targetEntityId: z.string().uuid(),
        /** Relation type slug, e.g. "depends_on", "assigned_to", "references" */
        type: z.string().min(1),
        metadata: z.record(z.string(), z.any()).optional(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId,
        ctx.sourceMessageId ?? undefined,
        ctx.sessionId ?? undefined
      );
      const caller = regularRelationsRouter.createCaller(callerContext);

      // relations.create already calls checkPermissionOrPropose internally
      // (which reads ctx.sessionId, so the link proposal groups under the run)
      const result = await caller.create({
        sourceEntityId: input.sourceEntityId,
        targetEntityId: input.targetEntityId,
        type: input.type,
        workspaceId: input.workspaceId,
        metadata: input.metadata,
      });

      return result;
    }),

  /**
   * Delete a relation
   * Requires: hub-protocol.write scope
   * Governance: generates a proposal (structural change)
   */
  deleteRelation: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        relationId: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId,
        ctx.sourceMessageId ?? undefined
      );
      const caller = regularRelationsRouter.createCaller(callerContext);

      // relations.delete already calls checkPermissionOrPropose internally
      const result = await caller.delete({
        id: input.relationId,
        workspaceId: input.workspaceId,
      });

      return result;
    }),
});
