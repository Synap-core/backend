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
// SECURITY: `compileWidgetSource` is UN-ROUTED from this door — its only caller
// was the `native` branch below. Kept on disk at utils/widget-compiler.ts.
import { assertMayActAs } from "./guard.js";
import { composeCatalogAsDefinitionRows } from "../../services/cells/compose-widget-catalog.js";

/**
 * SECURITY — rejection message for `rendererType: "native"`. DO-NOT-REVIVE-AS-IS.
 *
 * Mirrors the constant of the same name in `routers/widget-definitions.ts`; this
 * file is the SECOND write door into `widget_definitions` and both must refuse
 * `native` identically or the closed door is decorative.
 *
 * A native definition's `source` was compiled to `bundleSource`, shipped
 * unprojected to every workspace member by `.list`, and executed by the
 * browser's `NativeWidgetLoader` via `Blob` → `URL.createObjectURL` →
 * `<script src>` → `document.head` — arbitrary JS in the top-level document of
 * an IPC-privileged Electron renderer, with no `trustLevel` check on the path.
 * Re-enabling requires a REAL boundary (Worker / separate process / Wasm VM);
 * a same-VM shim is NOT acceptable (Figma's Realms shim was escaped repeatedly —
 * they moved to QuickJS on Wasm).
 */
const NATIVE_RENDERER_REJECTED =
  'rendererType "native" is no longer accepted: native bundles executed un-sandboxed ' +
  "in the host origin (arbitrary code execution in every workspace member's " +
  'renderer). Use "iframe" for a sandboxed HTML widget, or declare a sandboxed ' +
  "React cell through the cells door (`synap_create_cell` / `POST /cells/define`).";

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
      // Builtins live in the Browser cellRegistry, not necessarily in this
      // table (the seeder is best-effort and often missing on a live pod).
      // Agents were told this endpoint is the compose registry — without the
      // catalog merge they only see generated:* rows and invent keys.
      const existing = new Set(rows.map((r) => r.typeKey));
      const catalog = composeCatalogAsDefinitionRows().filter(
        (row) => !existing.has(row.typeKey as string)
      );
      return [...catalog, ...rows];
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
        // NOTE: no `frame`, and therefore deliberately NO `viewTypes` here.
        // A view renderer must register with `runtime: "frame"` (the render
        // chokepoint gates on it), and `runtime` derives from `rendererType`.
        // This door cannot emit `frame`, so a `viewTypes` slot would be a
        // declarable-but-ignored field. Declare affinity through `defineCell`
        // (MCP `synap_create_cell`, `POST /cells/define`, `POST /cells/install`).
        // SECURITY: `"native"` parses only to fail with an explanatory message
        // (a bare "invalid enum value" would leave an agent guessing); the
        // `.transform` strips it from the output type so no branch below can
        // reference it. DO-NOT-REVIVE-AS-IS — see NATIVE_RENDERER_REJECTED.
        rendererType: z
          .enum(["builtin", "iframe", "native"])
          .default("iframe")
          .superRefine((value, ctx) => {
            if (value === "native") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: NATIVE_RENDERER_REJECTED,
              });
            }
          })
          .transform((value) => value as Exclude<typeof value, "native">),
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
      // Identity floor: `input.userId` is the acting identity fed to
      // checkPermissionOrPropose — a hub PAT may act only as its own owner.
      assertMayActAs(ctx, input.userId);
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

      // UN-ROUTED (security) — the native compile step. `bundleSource` is now
      // always undefined from this door, so no executable bundle can be written.
      // DO-NOT-REVIVE-AS-IS; see NATIVE_RENDERER_REJECTED above.
      //
      //   if (input.rendererType === "native" && input.source) {
      //     try {
      //       bundleSource = await compileWidgetSource(input.source);
      //     } catch (err) {
      //       throw new TRPCError({
      //         code: "BAD_REQUEST",
      //         message: `Widget compilation failed: ${...}`,
      //       });
      //     }
      //   }
      const bundleSource: string | undefined = undefined;

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
