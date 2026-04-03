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

/** A single widget placement in the bento grid */
const BentoWidgetInputSchema = z.object({
  /** Cell key — any registered widget type (stat-card, entity-list, etc.) */
  key: z.string().min(1),
  /** Widget configuration (profileSlug, aggregation, chartType, etc.) */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Legacy props — merged into config for backward compat */
  props: z.record(z.string(), z.unknown()).optional(),
  /** Grid column (0-11, 12-column grid) */
  x: z.number().int().min(0).max(11),
  /** Grid row (0-based) */
  y: z.number().int().min(0),
  /** Width in grid columns (1-12) */
  w: z.number().int().min(1).max(12),
  /** Height in grid rows (row height = 60px) */
  h: z.number().int().min(1),
});

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
        agentUserId: input.agentUserId,
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
        agentUserId: input.agentUserId,
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

  /**
   * Arrange cells in a bento dashboard
   * Requires: hub-protocol.write scope
   * Governance: bento.arrange is AUTO-APPROVED — agents can freely arrange layouts.
   *
   * The 12-column grid uses a 60px row height. Cells are referenced by their
   * registered cell key (entity-detail, channel-feed, view, document, agent-activity).
   */
  arrangeBento: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        /** Target bento view to update */
        viewId: z.string().uuid(),
        /** New widget layout — replaces existing bento blocks */
        widgets: z.array(BentoWidgetInputSchema).min(1),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Permission check — bento.arrange is in DEFAULT_AUTO_APPROVE
      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId,
        subjectType: "bento",
        action: "arrange",
        source: "intelligence",
        reasoning: input.reasoning,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        data: { viewId: input.viewId, widgetCount: input.widgets.length },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        // This shouldn't happen since bento.arrange is auto-approved,
        // but handle gracefully if governance settings override the whitelist.
        return {
          status: "proposed" as const,
          message: "Bento arrangement proposed for review",
          proposalId: perm.proposalId,
        };
      }

      // Build bento config from widget input
      // Merge config + props (config takes priority, props is legacy fallback)
      const blocks = input.widgets.map((w, i) => ({
        id: `cell-${i}-${Date.now()}`,
        kind: "widget" as const,
        widgetType: w.key,
        config: { ...(w.props ?? {}), ...(w.config ?? {}) },
        pos: { x: w.x, y: w.y, w: w.w, h: w.h },
      }));

      // Update the view config
      const db = await getDb();
      await db
        .update(views)
        .set({
          config: { blocks },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(views.id, input.viewId),
            eq(views.workspaceId, input.workspaceId)
          )
        );

      return {
        status: "ok" as const,
        viewId: input.viewId,
        widgetCount: blocks.length,
        message: `Arranged ${blocks.length} cell${blocks.length !== 1 ? "s" : ""} in dashboard`,
      };
    }),
});
