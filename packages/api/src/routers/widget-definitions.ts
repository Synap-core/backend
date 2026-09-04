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
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { getDb, and, eq, or, isNull, asc } from "@synap/database";
import { widgetDefinitions, CONTENT_KINDS } from "@synap/database/schema";
import { scopedDb, accessFor } from "../access/index.js";
import { requireUserId } from "../utils/user-scoped.js";
// SECURITY: `compileWidgetSource` is UN-ROUTED from this router — its only
// caller was the `native` branch below. The import is REMOVED (not left
// unused); the function itself is kept on disk at `../utils/widget-compiler.ts`
// with its own DO-NOT-REVIVE-AS-IS header. See NATIVE_RENDERER_REJECTED.
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { randomUUID } from "crypto";

/**
 * SECURITY — rejection message for `rendererType: "native"`. DO-NOT-REVIVE-AS-IS.
 *
 * The native renderer was an arbitrary-code-execution path, not a feature with a
 * bug. `source` → `compileWidgetSource()` → `bundleSource` → `.list` (no column
 * projection, so every workspace member received it) → the browser's
 * `NativeWidgetLoader`, which wrapped the bundle in a `Blob`, minted an object
 * URL, and appended it as a `<script>` to `document.head`: same-origin JS in the
 * TOP-LEVEL document of an IPC-privileged Electron renderer. No iframe, no
 * worker, no process boundary; the renderer CSP (`script-src 'self'
 * 'unsafe-inline' blob:`) permits it, and the registration gate checked only
 * `rendererType === "native" && bundleSource` — never `trustLevel`.
 *
 * Do not re-enable without a REAL boundary (Worker / separate process / Wasm
 * VM). A same-VM shim is NOT acceptable — Figma shipped one (SES/Realms) and it
 * was escaped by multiple independent bugs; their fix was a different VM
 * (QuickJS on Wasm).
 */
const NATIVE_RENDERER_REJECTED =
  'rendererType "native" is no longer accepted: native bundles executed un-sandboxed ' +
  "in the host origin (arbitrary code execution in every workspace member's " +
  'renderer). Use "frame" for a sandboxed React cell, or "iframe" for sandboxed HTML.';

/**
 * Extract the first fenced code block from an LLM response. Falls back to the
 * whole text when no fence is present (some models reply with bare code).
 */
function extractCodeBlock(text: string): string {
  const fence = text.match(/```(?:[a-zA-Z]*)\n([\s\S]*?)```/);
  if (fence && fence[1]) return fence[1].trim();
  return text.trim();
}

/** Compact system brief telling the IS how to author a frame cell. */
function buildCellCodegenPrompt(
  description: string,
  language: "react" | "module",
  existingCode: string | undefined
): string {
  const reactRules = `Write a single self-contained ES module that \`export default\` a React function component.
- Import React from 'react' (e.g. \`import React, { useState, useEffect } from 'react'\`).
- Use inline styles or a <style> tag — there is no external CSS.
- To read pod data call \`window.SynapWidget.query('entities.list', { profileSlug })\` (returns a Promise) inside an effect; the host injects window.SynapWidget.
- Do NOT import react-dom or call createRoot — the host mounts your default export.`;
  const moduleRules = `Write a single self-contained ES module that mounts itself into \`document.getElementById('root')\`.
- Use \`window.SynapWidget.onInit((config, context) => { ... })\` to receive config, then render.
- Use plain DOM APIs or a <style> tag.`;

  return [
    "You are a Synap Cell author. Generate ONLY the source code for a sandboxed frame cell.",
    language === "react" ? reactRules : moduleRules,
    "Return the code in a single fenced code block, no prose before or after.",
    existingCode
      ? `Modify the following existing cell per the request, returning the FULL updated source:\n\n${existingCode}`
      : "",
    `Request: ${description}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

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
  /**
   * SECURITY: `"native"` is accepted by the parser ONLY so that a request asking
   * for it fails LOUDLY with the explanation below instead of a bare
   * "invalid enum value" — it can never validate, and `.transform` strips it
   * from the output type so no downstream branch can reference it.
   *
   * Why it is gone: a native definition's `source` was compiled to
   * `bundleSource`, shipped unprojected to every workspace member by `.list`,
   * and executed by the browser's `NativeWidgetLoader` via
   * `Blob` → `URL.createObjectURL` → `<script src>` → `document.head` — arbitrary
   * JS in the top-level document of an IPC-privileged Electron renderer, with no
   * `trustLevel` check anywhere on the path. DO-NOT-REVIVE-AS-IS.
   */
  rendererType: z
    .enum(["builtin", "iframe", "native", "frame"])
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
  /** What this cell renders — the de-conflated content taxonomy. Selected by the
   *  author (Cell Studio) / AI generator; defaults to the content-agnostic `widget`. */
  contentKind: z.enum(CONTENT_KINDS).optional(),
  rendererSource: z.string().optional(),
  /** Original JSX/TSX source for native widgets (compiled server-side) */
  source: z.string().optional(),
  /** npm package version pins for frame widgets, e.g. { 'recharts': '2.12.0' } */
  deps: z.record(z.string(), z.string()).optional(),
  /**
   * View types this cell can RENDER, e.g. ["list","table"] (migration 0221).
   * Copied onto the browser registration's `viewRenderer.viewTypes`; the render
   * chokepoint and the "Rendering style" picker both require it before a view
   * may bind to this cell. Omitted → the stored value is left untouched.
   */
  viewTypes: z.array(z.string().min(1).max(64)).max(32).optional(),
  configSchema: z.record(z.string(), z.unknown()).default({}),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
  defaultSize: z
    .object({ w: z.number().int().min(1).max(12), h: z.number().int().min(1) })
    .optional(),
  minSize: z
    .object({ w: z.number().int().min(1).max(12), h: z.number().int().min(1) })
    .optional(),
});

/**
 * Mirror of `normalizeViewTypes` in `services/cells/define-cell.ts` — trim,
 * drop empties, dedupe, and map "nothing left" to NULL. Kept in step with that
 * function deliberately: this router is a SECOND write door into the same
 * column, and two doors disagreeing on how "no affinity" is encoded is how a
 * column ends up with both `[]` and `null` meaning the same thing.
 */
function normalizeViewTypesForUpsert(raw: string[]): string[] | null {
  const cleaned = [
    ...new Set(
      raw
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t !== "")
    ),
  ];
  return cleaned.length > 0 ? cleaned : null;
}

export const widgetDefinitionsRouter = router({
  /**
   * List active widget definitions for a workspace.
   * Returns system-wide builtins first, then workspace-specific custom widgets.
   */
  // Workspace is a LENS: active workspace → that workspace's defs + pod-wide
  // builtins (NULL). Scoping is the registered `workspace` rule applied by
  // scopedDb.
  //
  // NO workspace → the caller's FULL floor (`workspacelessFloor: "user"`), not
  // builtins-only. The browser boots at pod altitude, and this is a boot read:
  // with the globals-only default a user's own custom widget definitions vanish
  // until they enter a Space, so every bento cell backed by one fails to
  // resolve. Failing NARROW is worse than failing closed here, and the floor is
  // unchanged — `workspaceLensWhere(undefined)` is `userVisibleWhere`.
  list: podProcedure.query(async ({ ctx }) => {
    const rows = await scopedDb(
      accessFor(ctx, { workspacelessFloor: "user" })
    ).findMany<typeof widgetDefinitions.$inferSelect>(widgetDefinitions, {
      where: eq(widgetDefinitions.isActive, true),
      orderBy: [
        // Builtins first (workspaceId null sorts before UUIDs)
        asc(widgetDefinitions.workspaceId),
        asc(widgetDefinitions.category),
        asc(widgetDefinitions.name),
      ],
    });
    return rows;
  }),

  /**
   * Lightweight metadata projection of {@link list}.
   *
   * Same scoping EXACTLY (the registered `workspace` VisibilityRule applied by
   * scopedDb, same `where`/`orderBy`) but selects ONLY the columns the browser's
   * "Made for you" lane reads — the provenance signals `aiOriginForCell` inspects
   * (`isActive`, `rendererType`, `typeKey`, `category`, `workspaceId`) plus the
   * display fields (`name`, `description`, `createdAt`, `updatedAt`). It DROPS the
   * heavy `rendererSource`/`bundleSource` blobs, so the lane's badge/count can be
   * derived without shipping compiled cell source. Studio still uses `list`.
   */
  listMeta: podProcedure.query(async ({ ctx }) => {
    const rows = await scopedDb(
      accessFor(ctx, { workspacelessFloor: "user" })
    ).findMany<
      Pick<
        typeof widgetDefinitions.$inferSelect,
        | "typeKey"
        | "isActive"
        | "rendererType"
        | "category"
        | "workspaceId"
        | "name"
        | "description"
        | "createdAt"
        | "updatedAt"
      >
    >(widgetDefinitions, {
      columns: {
        typeKey: true,
        isActive: true,
        rendererType: true,
        category: true,
        workspaceId: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
      where: eq(widgetDefinitions.isActive, true),
      orderBy: [
        // Builtins first (workspaceId null sorts before UUIDs)
        asc(widgetDefinitions.workspaceId),
        asc(widgetDefinitions.category),
        asc(widgetDefinitions.name),
      ],
    });
    return rows;
  }),

  /**
   * Get a single widget definition by typeKey.
   * Looks up system-wide first, then workspace-specific.
   */
  get: podProcedure
    .input(z.object({ typeKey: z.string() }))
    .query(async ({ ctx, input }) => {
      // Single-object read: the active workspace lens only PROJECTS (prefer this
      // workspace's override over the system-wide default) — it can never gate
      // the fetch. With no active workspace, scopedDb uses the caller's user
      // floor so workspace-scoped generated cells still resolve. Hence podProcedure.
      const wsId = ctx.workspaceId ?? null;
      // Workspace lens PROJECTS (this workspace's override over the system
      // default). With no active workspace the floor is the caller's visible
      // rows — NOT globals-only. A generated cell is usually workspace-scoped;
      // Host open after approve happens at pod altitude, and the old
      // `isNull(workspaceId)` fallback made `generated:*` unresolvable.
      const rows = await scopedDb(
        accessFor(ctx, { workspacelessFloor: "user" })
      ).findMany<typeof widgetDefinitions.$inferSelect>(widgetDefinitions, {
        where: and(
          eq(widgetDefinitions.typeKey, input.typeKey),
          eq(widgetDefinitions.isActive, true),
          ...(wsId
            ? [
                or(
                  isNull(widgetDefinitions.workspaceId),
                  eq(widgetDefinitions.workspaceId, wsId)
                )!,
              ]
            : [])
        ),
      });
      return (
        [...rows].sort(
          (a, b) => Number(!!b.workspaceId) - Number(!!a.workspaceId)
        )[0] ?? null
      );
    }),

  /**
   * Generate (or modify) frame-cell source from a natural-language description.
   *
   * Proxies to the workspace's active Intelligence Service via a one-shot
   * orchestrator message, then extracts the fenced code block. This is the
   * canonical in-studio AI codegen path — Cell Studio writes the returned
   * `source` straight into its editor. It does NOT persist anything; saving is
   * still the explicit upsert below (and stays governed there).
   */
  generateSource: workspaceProcedure
    .input(
      z.object({
        description: z.string().min(1).max(2000),
        language: z.enum(["react", "module"]).default("react"),
        existingCode: z.string().max(20000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: ctx.workspaceId,
        capability: "chat",
      });

      const prompt = buildCellCodegenPrompt(
        input.description,
        input.language,
        input.existingCode
      );

      try {
        const res = await client.sendMessage({
          query: prompt,
          threadId: randomUUID(),
          userId,
          workspaceId: ctx.workspaceId,
          agentId: "orchestrator",
          billingChannel: "browser",
        });
        const source = extractCodeBlock(res.content ?? "");
        if (!source) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "AI returned an empty response.",
          });
        }
        return { source, language: input.language };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cell generation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
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

      // UN-ROUTED (security): the `native` arity check below is unreachable —
      // `rendererType: "native"` now fails schema validation with
      // NATIVE_RENDERER_REJECTED and is stripped from the parsed type.
      // DO-NOT-REVIVE-AS-IS.
      //
      //   if (input.rendererType === "native" && !input.source) {
      //     throw new TRPCError({
      //       code: "BAD_REQUEST",
      //       message: "source (JSX/TSX) is required for native widgets",
      //     });
      //   }

      if (input.rendererType === "frame" && !input.rendererSource) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "rendererSource (raw ESM code) is required for frame widgets",
        });
      }

      // UN-ROUTED (security) — the native compile step. `bundleSource` is now
      // always undefined from this door, so the row it writes below can never
      // carry an executable bundle. DO-NOT-REVIVE-AS-IS: compiling the source is
      // harmless, but the ONLY consumer of `bundleSource` was the browser's
      // top-level-document `<script>` loader. See NATIVE_RENDERER_REJECTED.
      // `compileWidgetSource` itself is kept on disk (utils/widget-compiler.ts).
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
      //
      // Frame widgets store rendererSource as-is (raw ESM) — no compile step.
      const bundleSource: string | undefined = undefined;

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
          ...(input.contentKind && { contentKind: input.contentKind }),
          rendererSource: input.rendererSource,
          source: input.source,
          bundleSource,
          deps: input.deps ?? {},
          configSchema: input.configSchema,
          defaultConfig: input.defaultConfig ?? {},
          defaultSize: input.defaultSize ?? { w: 6, h: 4 },
          minSize: input.minSize,
          ...(input.viewTypes !== undefined && {
            // `!== undefined`, not truthiness: `[]` is truthy in JS, so the old
            // guard wrote `[]` where `defineCell`'s `normalizeViewTypes` maps
            // `[]` → null — two encodings of "no affinity" in one column.
            // Normalised here the same way so both write doors agree.
            viewRendererViewTypes: normalizeViewTypesForUpsert(input.viewTypes),
          }),
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
            ...(input.contentKind && { contentKind: input.contentKind }),
            rendererSource: input.rendererSource ?? null,
            source: input.source ?? null,
            bundleSource: bundleSource ?? null,
            deps: input.deps ?? {},
            configSchema: input.configSchema,
            defaultConfig: input.defaultConfig ?? {},
            ...(input.defaultSize && { defaultSize: input.defaultSize }),
            ...(input.minSize && { minSize: input.minSize }),
            ...(input.viewTypes !== undefined && {
              // `!== undefined`, not truthiness: `[]` is truthy in JS, so the old
              // guard wrote `[]` where `defineCell`'s `normalizeViewTypes` maps
              // `[]` → null — two encodings of "no affinity" in one column.
              // Normalised here the same way so both write doors agree.
              viewRendererViewTypes: normalizeViewTypesForUpsert(
                input.viewTypes
              ),
            }),
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
