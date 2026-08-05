/**
 * Cells Router
 *
 * Lifecycle management for ViewFrame cells installed from the marketplace.
 * Cells are persisted as widget_definitions with rendererType='frame'.
 *
 * - install:        fetch from CP, upsert into widget_definitions
 * - uninstall:      soft-delete (isActive=false)
 * - listInstalled:  return all frame-type cells for this workspace
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { getDb, and, eq } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import {
  installCellFromDefinition,
  packageCellTypeKey,
} from "../services/cells/install-cell-from-definition.js";

function requireAdminRole(role: string | undefined | null) {
  if (!["owner", "admin"].includes(role ?? "")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only workspace owners and admins can install or uninstall cells.",
    });
  }
}

function getCpUrl(): string {
  const url = (
    process.env.CONTROL_PLANE_URL ??
    process.env.CP_URL ??
    ""
  ).replace(/\/$/, "");
  if (!url) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Control Plane URL is not configured on this pod.",
    });
  }
  return url;
}

export const cellsRouter = router({
  /**
   * Install a cell from the marketplace.
   * Fetches the cell definition from CP, then upserts it into widget_definitions
   * as a frame-type widget scoped to the current workspace.
   */
  install: workspaceProcedure
    .input(
      z.object({
        packageSlug: z.string().min(1),
        cellKey: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workspaceId = ctx.workspaceId!;
      requireAdminRole(ctx.workspaceRole);
      const cpUrl = getCpUrl();
      const { packageSlug, cellKey } = input;

      // Fetch cell definition from CP
      let cell:
        | {
            key: string;
            name: string;
            code: string;
            deps?: Record<string, string>;
            description?: string;
            defaultSize?: { w: number; h: number };
            /** Renderer slot — see CP `PackageCellDef.contentKind`. */
            contentKind?: string;
            /** View-renderer affinity — see CP `PackageCellDef.viewTypes`. */
            viewTypes?: string[];
          }
        | undefined;

      try {
        const resp = await fetch(
          `${cpUrl}/api/marketplace/cells?q=${encodeURIComponent(cellKey)}`
        );
        if (!resp.ok) {
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message: `CP responded with ${resp.status} when fetching cell definition`,
          });
        }
        const data = (await resp.json()) as
          { cells?: (typeof cell)[] } | (typeof cell)[];
        const list = Array.isArray(data)
          ? data
          : ((data as { cells?: (typeof cell)[] }).cells ?? []);
        cell = list.find(
          (c) => c?.key === cellKey || c?.key === `${packageSlug}:${cellKey}`
        );
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `Failed to fetch cell from CP: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      if (!cell) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Cell '${cellKey}' not found in package '${packageSlug}'`,
        });
      }

      // Fix 4: verify CP-returned key matches what was requested (guard against tampering)
      const resolvedKey = cell.key.includes(":")
        ? cell.key.split(":").pop()!
        : cell.key;
      if (resolvedKey !== cellKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `CP returned cell key '${cell.key}' which does not match requested '${cellKey}'`,
        });
      }

      // Route through the SHARED package-cell mapper (→ the one write door
      // `defineCell`) instead of a third hand-rolled insert. That raw insert
      // skipped everything the door owns: `validateDeps` (deps are spliced into
      // esm.sh import-map URLs inside the sandboxed frame — the door's docblock
      // already named "marketplace install" as a caller that must not bypass
      // it), the `widget_definition.changed` realtime emit (so an install only
      // reached the browser on its 60s poll), `viewRendererViewTypes`, and — the
      // defect this fixes — `contentKind`. Without a contentKind the row lands as
      // the column default `widget`, which `renderersForType` never offers for
      // 'entity-detail' | 'entity-profile' | 'collection': the cell installed
      // fine and could never be chosen as a renderer.
      await installCellFromDefinition({
        definition: {
          key: cellKey,
          code: cell.code,
          deps: cell.deps,
          defaultSize: cell.defaultSize,
          viewTypes: cell.viewTypes,
          contentKind: cell.contentKind,
        },
        name: cell.name,
        description: cell.description ?? null,
        packageSlug,
        cellKey,
        workspaceId,
        userId: ctx.userId,
      });

      return {
        success: true,
        typeKey: packageCellTypeKey(packageSlug, cellKey),
      };
    }),

  /**
   * Uninstall a cell by soft-deleting its widget_definition (isActive=false).
   */
  uninstall: workspaceProcedure
    .input(z.object({ typeKey: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
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

  /**
   * List all installed frame-type cells for the current workspace.
   */
  listInstalled: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const rows = await db.query.widgetDefinitions.findMany({
      where: and(
        eq(widgetDefinitions.rendererType, "frame"),
        eq(widgetDefinitions.workspaceId, ctx.workspaceId!),
        eq(widgetDefinitions.isActive, true)
      ),
      orderBy: (t, { asc }) => [asc(t.name)],
    });

    return rows.map((r) => ({
      typeKey: r.typeKey,
      name: r.name,
      deps: (r.deps as Record<string, string>) ?? {},
      rendererSource: r.rendererSource ?? "",
    }));
  }),
});
