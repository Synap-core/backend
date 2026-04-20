/**
 * Hub Protocol - Widget Definitions Router
 *
 * IS-accessible sub-router for reading and upserting widget definitions.
 * Used by:
 *   - get-bento-schema-tool: live catalog lookup (instead of hardcoded list)
 *   - generate_widget tool: stores AI-generated iframe widget definitions
 *
 * Governance:
 *   - listWidgetDefs: auto-approved (read)
 *   - upsertWidgetDef: creates a proposal for user review
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { getDb, and, eq, or, isNull } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { TRPCError } from "@trpc/server";
import { compileWidgetSource } from "../../utils/widget-compiler.js";

export const hubWidgetDefinitionsRouter = router({
  /**
   * List active widget definitions for a workspace.
   * Returns system-wide builtins + workspace-specific widgets.
   * Requires: hub-protocol.read scope
   */
  listWidgetDefs: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      const rows = await db.query.widgetDefinitions.findMany({
        where: and(
          or(
            isNull(widgetDefinitions.workspaceId),
            input.workspaceId
              ? eq(widgetDefinitions.workspaceId, input.workspaceId)
              : undefined
          ),
          eq(widgetDefinitions.isActive, true)
        ),
        orderBy: (t, { asc }) => [asc(t.workspaceId), asc(t.name)],
      });
      return rows;
    }),

  /**
   * Create or update a workspace-specific widget definition.
   * Used by the generate_widget IS tool to store AI-generated iframe widgets.
   * Requires: hub-protocol.write scope
   * Governance: widget.register creates a proposal for user review.
   */
  upsertWidgetDef: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        typeKey: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9-]+$/),
        name: z.string().min(1).max(128),
        description: z.string().optional(),
        icon: z.string().optional(),
        category: z.string().optional(),
        rendererType: z.enum(["builtin", "iframe", "native"]).default("iframe"),
        rendererSource: z.string().optional(),
        /** Original JSX/TSX source for native widgets */
        source: z.string().optional(),
        configSchema: z.record(z.string(), z.unknown()).default({}),
        defaultConfig: z.record(z.string(), z.unknown()).optional(),
        defaultSize: z
          .object({
            w: z.number().int().min(1).max(12),
            h: z.number().int().min(1),
          })
          .optional(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Governance check — widget.register is NOT auto-approved
      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId ?? undefined,
        subjectType: "widget",
        action: "register",
        source: "intelligence",
        reasoning: input.reasoning,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        data: {
          typeKey: input.typeKey,
          name: input.name,
          rendererType: input.rendererType,
          rendererSourceLength: input.rendererSource?.length,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Widget registration proposed for review",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          widgetDef: null,
        };
      }

      // Compile native widget source to IIFE bundle
      let bundleSource: string | undefined;
      if (input.rendererType === "native" && input.source) {
        try {
          bundleSource = await compileWidgetSource(input.source);
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Widget compilation failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // Permission granted — upsert the definition
      const db = await getDb();
      const [row] = await db
        .insert(widgetDefinitions)
        .values({
          typeKey: input.typeKey,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          icon: input.icon,
          category: input.category ?? "ai",
          rendererType: input.rendererType,
          rendererSource: input.rendererSource,
          source: input.source,
          bundleSource,
          configSchema: input.configSchema,
          defaultConfig: input.defaultConfig ?? {},
          defaultSize: input.defaultSize ?? { w: 6, h: 4 },
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [widgetDefinitions.typeKey, widgetDefinitions.workspaceId],
          set: {
            name: input.name,
            description: input.description ?? null,
            icon: input.icon ?? null,
            category: input.category ?? "ai",
            rendererType: input.rendererType,
            rendererSource: input.rendererSource ?? null,
            source: input.source ?? null,
            bundleSource: bundleSource ?? null,
            configSchema: input.configSchema,
            defaultConfig: input.defaultConfig ?? {},
            ...(input.defaultSize && { defaultSize: input.defaultSize }),
            isActive: true,
            updatedAt: new Date(),
          },
        })
        .returning();

      return { status: "ok" as const, widgetDef: row };
    }),
});
