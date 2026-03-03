/**
 * Hub Protocol - Views Router
 *
 * Exposes view management to Intelligence Hub agents.
 * Delegates to the regular views API to ensure all validation,
 * event emission, and side-effect infrastructure is reused.
 *
 * Governance:
 *   - listViews:   auto-approved (read)
 *   - createView:  auto-approved (view.create in DEFAULT_AUTO_APPROVE)
 *   - updateView:  generates proposal (requires user review)
 *   - deleteView:  NOT exposed — agents cannot delete views
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { viewsRouter as regularViewsRouter } from "../views.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { getDb } from "@synap/database";
import { views } from "@synap/database/schema";
import { and, eq } from "drizzle-orm";

export const hubViewsRouter = router({
  /**
   * List views in a workspace
   * Requires: hub-protocol.read scope
   */
  listViews: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        profileId: z.string().uuid().optional(),
        type: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();

      const rows = await db.query.views.findMany({
        where: and(
          eq(views.workspaceId, input.workspaceId),
          input.type ? eq(views.type, input.type) : undefined,
          input.profileId
            ? // views store scopeProfileIds as JSONB array — simple text match
              // For simplicity, filter by profileId in memory after fetch
              undefined
            : undefined
        ),
        orderBy: (views, { desc }) => [desc(views.updatedAt)],
      });

      // If profileId requested, filter by scopeProfileIds
      if (input.profileId) {
        return rows.filter((v: any) => {
          const ids: string[] = v.scopeProfileIds ?? [];
          return ids.includes(input.profileId!);
        });
      }

      return rows;
    }),

  /**
   * Create a view
   * Requires: hub-protocol.write scope
   * Governance: view.create is auto-approved by DEFAULT_AUTO_APPROVE whitelist
   */
  createView: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        name: z.string().min(1).max(100),
        type: z.string().min(1),
        /** Required for structured views (list, kanban, table, etc.) */
        profileId: z.string().uuid().optional(),
        config: z.record(z.string(), z.any()).optional(),
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
        ctx.sourceMessageId ?? undefined
      );
      const caller = regularViewsRouter.createCaller(callerContext);

      const result = await caller.create({
        workspaceId: input.workspaceId,
        name: input.name,
        type: input.type,
        scopeProfileIds: input.profileId ? [input.profileId] : undefined,
        config: input.config,
        metadata: input.metadata,
        source: "intelligence",
        agentUserId: input.agentUserId ?? ctx.userId ?? undefined,
        reasoning: input.reasoning,
      });

      return result;
    }),

  /**
   * Update a view (name and/or config)
   * Requires: hub-protocol.write scope
   * Governance: view.update is NOT auto-approved — generates a proposal
   */
  updateView: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        viewId: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
        name: z.string().min(1).max(100).optional(),
        config: z.record(z.string(), z.any()).optional(),
        metadata: z.record(z.string(), z.any()).optional(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Resolve workspaceId — look it up if not provided
      let workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
      if (!workspaceId) {
        const db = await getDb();
        const view = await db.query.views.findFirst({
          where: eq(views.id, input.viewId),
          columns: { workspaceId: true },
        });
        workspaceId = view?.workspaceId ?? undefined;
      }

      // Governance check — view.update is NOT in auto-approve whitelist
      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        agentUserId: input.agentUserId ?? ctx.userId ?? undefined,
        workspaceId,
        subjectType: "view",
        action: "update",
        source: "intelligence",
        reasoning: input.reasoning,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        data: {
          id: input.viewId,
          name: input.name,
          config: input.config,
          metadata: input.metadata,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "View update proposed for review",
          proposalId: perm.proposalId,
          view: null,
        };
      }

      // Execute the update
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        workspaceId,
        ctx.sourceMessageId ?? undefined
      );
      const caller = regularViewsRouter.createCaller(callerContext);

      const result = await caller.update({
        id: input.viewId,
        name: input.name,
        config: input.config,
        // Note: views.update does not accept metadata — use views.save for content/metadata
      });

      return result;
    }),
});
