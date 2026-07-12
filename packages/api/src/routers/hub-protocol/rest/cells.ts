/**
 * Hub Protocol REST — cells (marketplace install/uninstall/list lifecycle)
 */

import { z } from "zod";
import { getDb, and, eq, isNull, or } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import {
  defineCell,
  validateDeps,
} from "../../../services/cells/define-cell.js";
import {
  hasScope,
  logger,
  verifyWorkspaceAccess,
  verifyWorkspaceReadAccess,
  type HubHono,
} from "./_shared.js";

// deps validation now lives INSIDE the defineCell door (security review
// 2026-07-12: marketplace-install called defineCell without it — enforcing at
// the door means no caller can skip it). Re-exported for the existing test.
export { validateDeps };

const InstallBodySchema = z.object({
  packageSlug: z.string().min(1),
  cellKey: z.string().min(1),
  workspaceId: z.string().optional(),
});

function getCpUrl(): string {
  return (process.env.CONTROL_PLANE_URL ?? process.env.CP_URL ?? "").replace(
    /\/$/,
    ""
  );
}

export function registerCellsRoutes(app: HubHono): void {
  /**
   * GET /cells?workspaceId=...
   * List installed ViewFrame cells for a workspace, plus pod-global cells (workspaceId IS NULL).
   * workspaceId is optional — when omitted, only pod-global cells are returned.
   */
  app.get("/cells", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const workspaceId = c.req.query("workspaceId");
    const userId = c.get("userId");
    if (
      workspaceId &&
      !(await verifyWorkspaceReadAccess(userId, workspaceId))
    ) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
    try {
      const db = await getDb();
      const rows = await db.query.widgetDefinitions.findMany({
        where: and(
          eq(widgetDefinitions.rendererType, "frame"),
          eq(widgetDefinitions.isActive, true),
          workspaceId
            ? or(
                isNull(widgetDefinitions.workspaceId),
                eq(widgetDefinitions.workspaceId, workspaceId)
              )
            : isNull(widgetDefinitions.workspaceId)
        ),
        orderBy: (t, { asc }) => [asc(t.name)],
      });
      return c.json(
        rows.map((r) => ({
          typeKey: r.typeKey,
          name: r.name,
          deps: (r.deps as Record<string, string>) ?? {},
          rendererSource: r.rendererSource ?? "",
        }))
      );
    } catch (err) {
      logger.error({ err }, "cells.listInstalled failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /cells/install
   * Install a cell from the marketplace into a workspace.
   * Body: { packageSlug, cellKey, workspaceId }
   */
  app.post("/cells/install", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const rawBody = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!rawBody) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = InstallBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }

    const { packageSlug, cellKey, workspaceId } = parsed.data;
    if (!workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }

    const userId = c.get("userId");
    if (!(await verifyWorkspaceAccess(userId, workspaceId))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }

    const cpUrl = getCpUrl();
    if (!cpUrl) {
      return c.json(
        {
          error:
            "Cell marketplace install requires CONTROL_PLANE_URL (or CP_URL) to be configured on this pod",
        },
        503
      );
    }

    try {
      const resp = await fetch(
        `${cpUrl}/api/marketplace/cells?q=${encodeURIComponent(cellKey)}`
      );
      if (!resp.ok) {
        return c.json({ error: `CP responded with ${resp.status}` }, 502);
      }
      const data = (await resp.json()) as { cells?: CellDef[] } | CellDef[];
      const list = Array.isArray(data)
        ? data
        : ((data as { cells?: CellDef[] }).cells ?? []);
      const cell = list.find(
        (cell) =>
          cell?.key === cellKey || cell?.key === `${packageSlug}:${cellKey}`
      );

      if (!cell) {
        return c.json(
          { error: `Cell '${cellKey}' not found in package '${packageSlug}'` },
          404
        );
      }

      // Fix 4: verify CP-returned key matches what was requested
      const resolvedKey = cell.key.includes(":")
        ? cell.key.split(":").pop()!
        : cell.key;
      if (resolvedKey !== cellKey) {
        return c.json(
          {
            error: `CP returned cell key '${cell.key}' which does not match requested '${cellKey}'`,
          },
          400
        );
      }

      const depsError = validateDeps(cell.deps);
      if (depsError) {
        return c.json({ error: depsError }, 400);
      }

      // Route through the ONE door (defineCell) — same idempotent upsert +
      // realtime event MCP's synap_create_cell and POST /cells/define use.
      // Pass the pre-existing marketplace typeKey scheme explicitly so
      // already-installed cells keep resolving under it.
      const { typeKey } = await defineCell({
        name: cell.name,
        rendererSource: cell.code,
        workspaceId,
        typeKey: `cell:${packageSlug}:${cellKey}`,
        description: cell.description,
        defaultSize: cell.defaultSize,
        deps: cell.deps,
        userId: userId ?? "",
      });

      return c.json({ success: true, typeKey });
    } catch (err) {
      logger.error({ err }, "cells.install failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /cells/define
   * Define a new cell from raw source (Capability B: AI-generated cells).
   * Idempotent upsert on (typeKey, workspaceId).
   * When workspaceId is omitted the cell is pod-global (visible in all workspaces).
   * Body: { name, rendererSource, workspaceId?, typeKey?, description?, defaultSize? }
   */
  app.post("/cells/define", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const rawBody = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!rawBody) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = z
      .object({
        name: z.string().min(1).max(120),
        rendererSource: z.string().min(1),
        workspaceId: z.string().min(1).optional(),
        typeKey: z.string().min(1).max(120).optional(),
        description: z.string().max(500).optional(),
        defaultSize: z.object({ w: z.number(), h: z.number() }).optional(),
        deps: z
          .record(z.string(), z.string())
          .optional()
          .superRefine((val, ctx) => {
            const message = validateDeps(val);
            if (message) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message });
            }
          }),
      })
      .safeParse(rawBody);

    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }

    const {
      name,
      rendererSource,
      workspaceId,
      description,
      defaultSize,
      deps,
    } = parsed.data;
    const userId = c.get("userId");

    // Only gate workspace access when a specific workspace is targeted
    if (workspaceId && !(await verifyWorkspaceAccess(userId, workspaceId))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }

    try {
      const { typeKey } = await defineCell({
        name,
        rendererSource,
        workspaceId: workspaceId ?? null,
        typeKey: parsed.data.typeKey,
        description,
        defaultSize,
        deps,
        userId: userId ?? "",
      });

      return c.json({ success: true, typeKey }, 201);
    } catch (err) {
      logger.error({ err }, "cells.define failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * DELETE /cells/:typeKey?workspaceId=...
   * Uninstall a cell (soft-delete widget_definition).
   * workspaceId is optional — when omitted, deletes the pod-global row (workspaceId IS NULL).
   */
  app.delete("/cells/:typeKey", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const typeKey = c.req.param("typeKey");
    const workspaceId = c.req.query("workspaceId");
    const userId = c.get("userId");
    if (workspaceId && !(await verifyWorkspaceAccess(userId, workspaceId))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
    try {
      const db = await getDb();
      await db
        .update(widgetDefinitions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(widgetDefinitions.typeKey, typeKey),
            workspaceId
              ? eq(widgetDefinitions.workspaceId, workspaceId)
              : isNull(widgetDefinitions.workspaceId)
          )
        );
      return c.json({ success: true });
    } catch (err) {
      logger.error({ err }, "cells.uninstall failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}

interface CellDef {
  key: string;
  name: string;
  code: string;
  deps?: Record<string, string>;
  description?: string;
  defaultSize?: { w: number; h: number };
}
