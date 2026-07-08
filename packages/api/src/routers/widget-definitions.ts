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
import { widgetDefinitions } from "@synap/database/schema";
import { scopedDb, accessFor } from "../access/index.js";
import { requireUserId } from "../utils/user-scoped.js";
import { compileWidgetSource } from "../utils/widget-compiler.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { randomUUID } from "crypto";

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
  rendererType: z
    .enum(["builtin", "iframe", "native", "frame"])
    .default("iframe"),
  /** What this cell renders — the de-conflated content taxonomy. Selected by the
   *  author (Cell Studio) / AI generator; defaults to the content-agnostic `widget`. */
  contentKind: z
    .enum(["entity-detail", "entity-profile", "collection", "widget"])
    .optional(),
  rendererSource: z.string().optional(),
  /** Original JSX/TSX source for native widgets (compiled server-side) */
  source: z.string().optional(),
  /** npm package version pins for frame widgets, e.g. { 'recharts': '2.12.0' } */
  deps: z.record(z.string(), z.string()).optional(),
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
  // builtins (NULL); no workspace → builtins only (lens=null). Scoping is the
  // registered `workspace` rule applied by scopedDb — behaviour-identical to the
  // prior hand-rolled `or(isNull, eq(ws))` / `isNull` branch.
  list: podProcedure.query(async ({ ctx }) => {
    const rows = await scopedDb(accessFor(ctx)).findMany<
      typeof widgetDefinitions.$inferSelect
    >(widgetDefinitions, {
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
      const db = await getDb();
      // Single-object read: the active workspace lens only PROJECTS (prefer this
      // workspace's override over the system-wide default) — it can never gate
      // the fetch. With no active workspace (pod-wide lens) it falls back to the
      // system-wide definition instead of blocking. Hence podProcedure.
      const wsId = ctx.workspaceId ?? null;
      const row = await db.query.widgetDefinitions.findFirst({
        where: and(
          eq(widgetDefinitions.typeKey, input.typeKey),
          wsId
            ? or(
                isNull(widgetDefinitions.workspaceId),
                eq(widgetDefinitions.workspaceId, wsId)
              )
            : isNull(widgetDefinitions.workspaceId),
          eq(widgetDefinitions.isActive, true)
        ),
        orderBy: (t, { desc }) => [desc(t.workspaceId)], // workspace-specific first
      });
      return row ?? null;
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

      if (input.rendererType === "native" && !input.source) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "source (JSX/TSX) is required for native widgets",
        });
      }

      if (input.rendererType === "frame" && !input.rendererSource) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "rendererSource (raw ESM code) is required for frame widgets",
        });
      }

      // Compile native widget source to IIFE bundle.
      // Frame widgets store rendererSource as-is (raw ESM) — no compile step.
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
