/**
 * Widget Definitions Router
 *
 * CRUD for the widget_definitions table.
 * - list: returns system-wide + workspace-specific active definitions (builtins first)
 * - get: fetch a single definition by typeKey
 * - upsert: create or update a widget definition (owner/admin only for workspace defs)
 * - deactivate: soft-delete (blocks using this typeKey will show an error placeholder)
 *
 * Builtin widgets (workspaceId = null) are read-only from the frontend — only
 * the seeder can create them. Workspace widgets require owner/admin role.
 */

import { z } from "zod";
import { router, workspaceProcedure, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { getDb } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import { and, eq, or, isNull } from "drizzle-orm";
import { requireUserId } from "../utils/user-scoped.js";

function requireAdminRole(role: string | undefined | null) {
  if (!["owner", "admin"].includes(role ?? "")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only workspace owners and admins can manage widget definitions.",
    });
  }
}

const WidgetUpsertSchema = z.object({
  typeKey: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9-]+$/, {
      message: "typeKey must be kebab-case (e.g. 'win-rate-gauge')",
    }),
  name: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  icon: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  rendererType: z.enum(["builtin", "iframe"]).default("iframe"),
  rendererSource: z.string().optional(),
  configSchema: z.record(z.string(), z.unknown()).default({}),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
  defaultSize: z
    .object({ w: z.number().int().min(1).max(12), h: z.number().int().min(1) })
    .optional(),
  minSize: z
    .object({ w: z.number().int().min(1).max(12), h: z.number().int().min(1) })
    .optional(),
});

export const widgetDefinitionsRouter = router({
  /**
   * List active widget definitions for a workspace.
   * Returns system-wide builtins first, then workspace-specific custom widgets.
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const rows = await db.query.widgetDefinitions.findMany({
      where: and(
        or(
          isNull(widgetDefinitions.workspaceId),
          eq(widgetDefinitions.workspaceId, ctx.workspaceId!)
        ),
        eq(widgetDefinitions.isActive, true)
      ),
      orderBy: (t, { asc, desc }) => [
        // Builtins first (workspaceId null sorts before UUIDs)
        asc(t.workspaceId),
        asc(t.category),
        asc(t.name),
      ],
    });
    return rows;
  }),

  /**
   * Get a single widget definition by typeKey.
   * Looks up system-wide first, then workspace-specific.
   */
  get: workspaceProcedure
    .input(z.object({ typeKey: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      // Prefer workspace-specific over system-wide
      const row = await db.query.widgetDefinitions.findFirst({
        where: and(
          eq(widgetDefinitions.typeKey, input.typeKey),
          or(
            isNull(widgetDefinitions.workspaceId),
            eq(widgetDefinitions.workspaceId, ctx.workspaceId!)
          ),
          eq(widgetDefinitions.isActive, true)
        ),
        orderBy: (t, { desc }) => [desc(t.workspaceId)], // workspace-specific first
      });
      return row ?? null;
    }),

  /**
   * Create or update a workspace-specific widget definition.
   * Requires owner or admin role.
   * Built-in widgets (workspaceId = null) cannot be managed here.
   */
  upsert: workspaceProcedure
    .input(WidgetUpsertSchema)
    .mutation(async ({ ctx, input }) => {
      requireUserId(ctx.userId);
      requireAdminRole(ctx.workspaceRole);

      if (input.rendererType === "iframe" && !input.rendererSource) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "rendererSource is required for iframe widgets",
        });
      }

      const db = await getDb();
      const [row] = await db
        .insert(widgetDefinitions)
        .values({
          typeKey: input.typeKey,
          workspaceId: ctx.workspaceId!,
          name: input.name,
          description: input.description,
          icon: input.icon,
          category: input.category ?? "app-specific",
          rendererType: input.rendererType,
          rendererSource: input.rendererSource,
          configSchema: input.configSchema,
          defaultConfig: input.defaultConfig ?? {},
          defaultSize: input.defaultSize ?? { w: 6, h: 4 },
          minSize: input.minSize,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [widgetDefinitions.typeKey, widgetDefinitions.workspaceId],
          set: {
            name: input.name,
            description: input.description ?? null,
            icon: input.icon ?? null,
            category: input.category ?? "app-specific",
            rendererType: input.rendererType,
            rendererSource: input.rendererSource ?? null,
            configSchema: input.configSchema,
            defaultConfig: input.defaultConfig ?? {},
            ...(input.defaultSize && { defaultSize: input.defaultSize }),
            ...(input.minSize && { minSize: input.minSize }),
            isActive: true,
            updatedAt: new Date(),
          },
        })
        .returning();

      return row;
    }),

  /**
   * Soft-delete a workspace widget definition.
   * Blocks using this typeKey will render a "Widget unavailable" placeholder.
   * Requires owner or admin role.
   */
  deactivate: workspaceProcedure
    .input(z.object({ typeKey: z.string() }))
    .mutation(async ({ ctx, input }) => {
      requireUserId(ctx.userId);
      requireAdminRole(ctx.workspaceRole);

      const db = await getDb();
      await db
        .update(widgetDefinitions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(widgetDefinitions.typeKey, input.typeKey),
            eq(widgetDefinitions.workspaceId, ctx.workspaceId!)
          )
        );

      return { success: true };
    }),
});
