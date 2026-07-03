/**
 * Hub Protocol - Automations Router
 *
 * Thin wrapper around the regular automations router.
 * Called by Intelligence Service via API key auth.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { automationsRouter as regularAutomationsRouter } from "../automations.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const hubAutomationsRouter = router({
  /**
   * Create automation (draft)
   * Requires: hub-protocol.write scope
   */
  createAutomation: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        agentUserId: z.string().uuid().optional(),
        workspaceId: z.string().uuid().nullable().optional(),
        sourceMessageId: z.string().optional(),
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        triggerType: z.enum(["event", "cron", "webhook", "manual"]),
        triggerConfig: z.record(z.string(), z.unknown()).default({}),
        flowDefinition: z.object({
          nodes: z.array(z.record(z.string(), z.unknown())),
          edges: z.array(z.record(z.string(), z.unknown())),
        }),
        status: z.enum(["draft", "active", "paused", "error"]).default("draft"),
        metadata: z.record(z.string(), z.unknown()).optional(),
        state: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null,
        input.sourceMessageId
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);

      return caller.create({
        workspaceId: input.workspaceId ?? null,
        name: input.name,
        description: input.description,
        triggerType: input.triggerType,
        triggerConfig: input.triggerConfig,
        flowDefinition: input.flowDefinition,
        status: input.status,
        metadata: input.metadata,
        state: input.state,
        agentUserId: input.agentUserId,
        source: input.agentUserId ? "agent" : "intelligence",
      });
    }),

  /**
   * List automations for a workspace
   * Requires: hub-protocol.read scope
   */
  listAutomations: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        status: z.enum(["draft", "active", "paused", "error"]).optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);

      return caller.list({
        workspaceId: input.workspaceId ?? null,
        status: input.status,
        limit: input.limit,
      });
    }),

  /**
   * Get single automation
   * Requires: hub-protocol.read scope
   */
  getAutomation: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        id: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);

      return caller.get({
        id: input.id,
        workspaceId: input.workspaceId ?? null,
      });
    }),

  /**
   * Update automation (e.g., AI modifying a draft)
   * Requires: hub-protocol.write scope
   */
  updateAutomation: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        id: z.string().uuid(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
        triggerType: z.enum(["event", "cron", "webhook", "manual"]).optional(),
        triggerConfig: z.record(z.string(), z.unknown()).optional(),
        flowDefinition: z
          .object({
            nodes: z.array(z.record(z.string(), z.unknown())),
            edges: z.array(z.record(z.string(), z.unknown())),
          })
          .optional(),
        status: z.enum(["draft", "active", "paused", "error"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        state: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);
      return caller.update({
        id: input.id,
        workspaceId: input.workspaceId ?? null,
        name: input.name,
        description: input.description,
        triggerType: input.triggerType,
        triggerConfig: input.triggerConfig,
        flowDefinition: input.flowDefinition,
        status: input.status,
        metadata: input.metadata,
        state: input.state,
      });
    }),

  /**
   * Activate automation
   * Requires: hub-protocol.write scope
   */
  activateAutomation: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);
      return caller.activate({
        id: input.id,
        workspaceId: input.workspaceId ?? null,
      });
    }),

  /**
   * Pause automation
   * Requires: hub-protocol.write scope
   */
  pauseAutomation: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);
      return caller.pause({
        id: input.id,
        workspaceId: input.workspaceId ?? null,
      });
    }),

  /**
   * Delete automation
   * Requires: hub-protocol.write scope
   */
  deleteAutomation: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);
      return caller.delete({
        id: input.id,
        workspaceId: input.workspaceId ?? null,
      });
    }),

  /**
   * Trigger automation manually (from IS or UI via IS)
   * Requires: hub-protocol.write scope
   */
  triggerAutomation: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        id: z.string().uuid(),
        payload: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);
      return caller.trigger({
        id: input.id,
        workspaceId: input.workspaceId ?? null,
        payload: input.payload,
      });
    }),

  /**
   * List runs for an automation
   * Requires: hub-protocol.read scope
   */
  listRuns: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        automationId: z.string().uuid(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);
      return caller.listRuns({
        workspaceId: input.workspaceId ?? null,
        automationId: input.automationId,
        limit: input.limit,
      });
    }),

  /**
   * Get run details with step runs
   * Requires: hub-protocol.read scope
   */
  getRun: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        runId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId ?? null
      );
      const caller = regularAutomationsRouter.createCaller(callerContext);
      return caller.getRun({
        runId: input.runId,
        workspaceId: input.workspaceId ?? null,
      });
    }),
});
