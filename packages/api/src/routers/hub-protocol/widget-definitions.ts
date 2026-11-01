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
 *   - upsertWidgetDef: filed as `cell.define` (a proposal for user review) and
 *     written by `defineCell`, the ONE writer of `widget_definitions`
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { getDb, eq } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { TRPCError } from "@trpc/server";
// SECURITY: `compileWidgetSource` is UN-ROUTED from this door — its only caller
// was the `native` branch below. Kept on disk at utils/widget-compiler.ts.
import { assertMayActAs } from "./guard.js";
import { actingAgentUserId } from "./utils.js";
import { listRenderables } from "../../services/cells/renderables.js";
import {
  CellDefinitionError,
  defineCell,
} from "../../services/cells/define-cell.js";
import {
  assertMayWriteNamespacedTypeKey,
  NamespacedTypeKeyError,
} from "../../services/cells/namespaced-type-key.js";

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
   * List everything renderable in a workspace: the built-in catalog plus
   * system-wide and workspace-specific widget_definitions rows, each carrying
   * the catalog fields (placements, requiredConfig, aiPlaceable, aiHint, …).
   * Requires: hub-protocol.read scope
   */
  listWidgetDefs: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    // The one read door: the built-in catalog (in-process) ∪ this pod's
    // installed / AI-defined rows. See services/cells/renderables.ts.
    .query(async ({ input }) => listRenderables(input.workspaceId ?? null)),

  /**
   * Create or update a workspace-specific widget definition.
   * Used by the generate_widget IS tool to store AI-generated iframe widgets.
   * Requires: hub-protocol.write scope
   * Governance: filed as `cell.define` (the same gate as `synap_create_cell`);
   * written by `defineCell`. `widget.register` is the LEGACY key — its pending
   * proposals are still approvable (executors/widget.ts) but nothing files it.
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
          .optional()
          .superRefine((value, ctx) => {
            if (value === "native") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: NATIVE_RENDERER_REJECTED,
              });
            }
          })
          .transform(
            (value) => value as Exclude<typeof value, "native"> | undefined
          ),
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
      const agentUserId = await actingAgentUserId(ctx, input.agentUserId);
      // Identity floor: `input.userId` is the acting identity fed to
      // checkPermissionOrPropose — a hub PAT may act only as its own owner.
      assertMayActAs(ctx, input.userId);
      // Built-in renderable keys are reserved (the catalog always wins on
      // read) — refuse before filing a proposal nobody could apply.
      try {
        await assertMayWriteNamespacedTypeKey(
          input.typeKey,
          input.workspaceId ?? null
        );
      } catch (err) {
        if (err instanceof NamespacedTypeKeyError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
      // `defineCell` stores renderer code only; a definition with none cannot
      // render. Refuse before filing a proposal nobody could apply.
      if (!input.rendererSource) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `rendererSource is required${
            input.rendererType ? ` for ${input.rendererType} widgets` : ""
          }`,
        });
      }
      // Governance check — cell.define is NOT auto-approved. Same key and same
      // payload shape as `synap_create_cell` / `POST /cells/define`, so the
      // `cell/define` approve-executor materialises it through `defineCell`.
      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        agentUserId,
        workspaceId: input.workspaceId ?? undefined,
        subjectType: "cell",
        action: "define",
        source: "intelligence",
        reasoning: input.reasoning,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        // The full define shape: the reviewer reads the renderer code, and the
        // executor writes exactly what was approved. `rendererType: "native"`
        // is rejected at the schema, so no executable bundle can ride in here.
        data: {
          typeKey: input.typeKey,
          workspaceId: input.workspaceId ?? null,
          name: input.name,
          description: input.description,
          icon: input.icon,
          category: input.category,
          rendererType: input.rendererType,
          rendererSource: input.rendererSource,
          configSchema: input.configSchema,
          defaultConfig: input.defaultConfig,
          defaultSize: input.defaultSize,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: proposedMessageFor(
            perm.proposalType,
            "Widget registration proposed for review"
          ),
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          widgetDef: null,
        };
      }

      // Permission granted — write through the ONE cell writer. It derives the
      // mechanism when none was named, validates deps, enforces the agent floor
      // and emits `widget_definition.*.completed`. (The native compile step is
      // gone; see NATIVE_RENDERER_REJECTED.)
      let written: Awaited<ReturnType<typeof defineCell>>;
      try {
        written = await defineCell({
          typeKey: input.typeKey,
          workspaceId: input.workspaceId ?? null,
          name: input.name,
          description: input.description ?? null,
          icon: input.icon,
          category: input.category ?? "ai",
          rendererType: input.rendererType,
          rendererSource: input.rendererSource,
          configSchema: input.configSchema,
          defaultConfig: input.defaultConfig,
          defaultSize: input.defaultSize,
          userId: input.userId,
        });
      } catch (err) {
        if (err instanceof CellDefinitionError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }

      // Read back the row the writer just wrote, by its id alone.
      const db = await getDb();
      const [row] = await db
        .select()
        .from(widgetDefinitions)
        .where(eq(widgetDefinitions.id, written.id))
        .limit(1);

      return { status: "ok" as const, widgetDef: row };
    }),
});
