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
import {
  CellDefinitionError,
  defineCell,
} from "../services/cells/define-cell.js";
// The typeKey PROVENANCE FLOOR, shared with the Hub REST cell-define door. It
// used to live here as a private function while `POST /cells/define` had no
// guard at all; one implementation is the point.
import {
  assertMayWriteNamespacedTypeKey,
  NamespacedTypeKeyError,
} from "../services/cells/namespaced-type-key.js";
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

/**
 * typeKey NAMESPACES — the three shapes a `widget_definitions.type_key` may
 * take, and what each one CLAIMS about where the row came from.
 *
 *   bare kebab        `win-rate-gauge`  — authored here (Cell Studio) or seeded builtin
 *   `generated:<slug>`                  — minted by `defineCell` for an AI-defined cell
 *   `cell:<pkg>:<key>`                  — minted by the package installer
 *                                         (`packageCellTypeKey`)
 *
 * The old `^[a-z][a-z0-9-]+$` here accepted ONLY the first, which meant Cell
 * Studio could not re-save a cell it had loaded through "Browse cells" if that
 * cell had been installed or AI-defined — the colon failed validation and
 * "install then tweak" was impossible.
 *
 * What the old regex was genuinely guarding is NOT character safety: `typeKey`
 * is interpolated into `/open/cell/<key>` hrefs, and `OPEN_ID_RE`
 * (`apps/api/src/open-dispatch.ts`) already permits `[A-Za-z0-9_.:-]` precisely
 * because `generated:` keys are load-bearing there. Every alternative below
 * stays strictly inside that class and stays lowercase, so nothing about href
 * safety changes.
 *
 * What it WAS guarding, by accident, is PROVENANCE: two shipped surfaces read
 * the prefix as a claim of origin — the browser's "Made for you" lane treats
 * `generated:` as AI-authored (`apps/made-for-you.ts`), and the installed list
 * parses `cell:<pkg>:` back to a package slug
 * (`hub-protocol/rest/installed.ts`). That guarantee is real and is kept
 * separately, by `assertMayWriteNamespacedTypeKey`
 * (`services/cells/namespaced-type-key.ts`, shared with the Hub REST
 * cell-define door): a door may UPDATE a namespaced row that already exists,
 * but may never MINT one.
 */
const TYPE_KEY_RE =
  /^(?:[a-z][a-z0-9-]+|generated:[a-z0-9][a-z0-9._-]*|cell:[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*)$/;

const WidgetUpsertSchema = z.object({
  typeKey: z
    .string()
    .min(1)
    .max(100)
    .regex(TYPE_KEY_RE, {
      message:
        "typeKey must be kebab-case (e.g. 'win-rate-gauge'), or an existing " +
        "'generated:<slug>' / 'cell:<package>:<key>' cell key",
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
  // `source` (original JSX/TSX for a native widget) is REMOVED, not left
  // accepted-and-ignored. Its only purpose was to be compiled into
  // `bundleSource` for `rendererType: "native"`, which this schema now refuses
  // outright — so the field could never carry meaning again, and a field a door
  // accepts but never writes is a declarable-but-ignored slot. No caller passes
  // it (verified across every repo). DO-NOT-REVIVE-AS-IS.
  /**
   * npm package version pins for frame widgets, e.g. { 'recharts': '2.12.0' }.
   *
   * NOT validated here: `defineCell` (the one write door this mutation
   * delegates to) runs `validateDeps` on every path, so the npm-name/version
   * regexes and the 30-entry cap live in exactly one place. This door used to
   * accept `z.record(string, string)` and write it straight to the column,
   * which put an unvalidated string into an `esm.sh` import-map URL inside the
   * sandboxed frame.
   */
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
   *
   * TRANSPORT ONLY — the WRITE is `defineCell`.
   *
   * This mutation used to carry its own `insert(...).onConflictDoUpdate(...)`
   * into `widget_definitions`, which made it a SECOND write door into the same
   * rows as `services/cells/define-cell.ts`, with weaker rules: it never ran
   * `validateDeps` (so an unvalidated dep string reached an `esm.sh` import-map
   * URL inside the sandboxed frame), it never emitted the realtime
   * `widget_definition.*` event (so a Cell Studio save notified nothing), and it
   * rejected every namespaced typeKey (so an installed cell could not be
   * edited). Two doors, one table, forked rules.
   *
   * What stays HERE is the part that is genuinely this door's: tRPC transport,
   * the owner/admin gate, the `native` refusal, the arity checks, and the
   * namespace-mint guard. Everything about the ROW is decided by `defineCell`.
   *
   * What the two doors did DIFFERENTLY and that survived as explicit parameters
   * of the one door (rather than being flattened): `rendererType` (this door
   * authors `iframe`/`builtin` too, `defineCell` hardcoded `frame`) and
   * `category` (a Cell Studio cell is AUTHORED — `app-specific` — where a
   * package cell is `installed`).
   */
  upsert: workspaceProcedure
    .input(WidgetUpsertSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      requireAdminRole(ctx.workspaceRole);
      const workspaceId = ctx.workspaceId!;

      // UN-ROUTED (security): the `native` arity check is unreachable —
      // `rendererType: "native"` fails schema validation with
      // NATIVE_RENDERER_REJECTED and is stripped from the parsed type.
      // DO-NOT-REVIVE-AS-IS. `bundleSource` therefore has no producer on this
      // path at all any more, and `defineCell` has no slot for one.
      //
      // Every remaining mechanism this door writes carries its own renderer, so
      // the arity check is now one rule instead of a per-type ladder.
      if (!input.rendererSource) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `rendererSource is required for ${input.rendererType} widgets`,
        });
      }

      // Provenance floor — see `assertMayWriteNamespacedTypeKey`. Runs BEFORE
      // the write so a forged `cell:`/`generated:` key never reaches the row.
      try {
        await assertMayWriteNamespacedTypeKey(input.typeKey, workspaceId);
      } catch (err) {
        // A caller error, not a server one — keep the 400 this door has always
        // returned now that the check lives in a shared, door-agnostic module.
        if (err instanceof NamespacedTypeKeyError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }

      try {
        await defineCell({
          typeKey: input.typeKey,
          workspaceId,
          name: input.name,
          description: input.description ?? null,
          icon: input.icon,
          // The two REAL differences, now explicit parameters rather than a
          // reason to keep a second door.
          rendererType: input.rendererType,
          category: input.category ?? "app-specific",
          rendererSource: input.rendererSource,
          contentKind: input.contentKind,
          // Validated inside `defineCell` (`validateDeps`) — the whole point of
          // the consolidation.
          deps: input.deps,
          // `undefined` here is SILENCE, not "clear": `defineCell` leaves a
          // stored affinity untouched, and normalises `[]` → null, so the two
          // encodings this router used to maintain its own copy of are now
          // decided in exactly one place.
          viewTypes: input.viewTypes,
          configSchema: input.configSchema,
          defaultConfig: input.defaultConfig,
          defaultSize: input.defaultSize,
          minSize: input.minSize,
          userId,
        });
      } catch (err) {
        // A contradictory definition (`contentKind` vs `viewTypes`) is the
        // caller's payload too — same BAD_REQUEST lane as a rejected dep, and
        // Cell Studio renders the message directly.
        if (err instanceof CellDefinitionError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        // `defineCell` throws a plain Error for a rejected dep. Surface it as
        // BAD_REQUEST — it is the caller's payload that is wrong, and Cell
        // Studio renders the message directly.
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("defineCell: ")) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: message.slice("defineCell: ".length),
          });
        }
        throw err;
      }

      // Re-read so the mutation keeps returning the full row it always has
      // (its tRPC output type is unchanged). `defineCell` returns only
      // `{ typeKey, changeType }` because that is all its other callers need.
      const db = await getDb();
      const [row] = await db
        .select()
        .from(widgetDefinitions)
        .where(
          and(
            eq(widgetDefinitions.typeKey, input.typeKey),
            eq(widgetDefinitions.workspaceId, workspaceId)
          )
        )
        .limit(1);

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
