/**
 * Hub Protocol REST — cells (marketplace install/uninstall/list lifecycle)
 */

import { z } from "zod";
import { getDb, and, eq } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import {
  hasScope,
  logger,
  verifyWorkspaceAccess,
  verifyWorkspaceReadAccess,
  type HubHono,
} from "./_shared.js";

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
   * List installed ViewFrame cells for a workspace.
   */
  app.get("/cells", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "workspaceId query param is required" }, 400);
    }
    const userId = c.get("userId");
    if (!(await verifyWorkspaceReadAccess(userId, workspaceId))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
    try {
      const db = await getDb();
      const rows = await db.query.widgetDefinitions.findMany({
        where: and(
          eq(widgetDefinitions.rendererType, "frame"),
          eq(widgetDefinitions.workspaceId, workspaceId),
          eq(widgetDefinitions.isActive, true)
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
        { error: "Control Plane URL is not configured on this pod" },
        500
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

      const typeKey = `cell:${packageSlug}:${cellKey}`;
      const db = await getDb();
      await db
        .insert(widgetDefinitions)
        .values({
          typeKey,
          workspaceId,
          name: cell.name,
          description: cell.description,
          category: "installed",
          rendererType: "frame",
          rendererSource: cell.code,
          deps: cell.deps ?? {},
          configSchema: {},
          defaultConfig: {},
          defaultSize: cell.defaultSize ?? { w: 6, h: 4 },
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [widgetDefinitions.typeKey, widgetDefinitions.workspaceId],
          set: {
            name: cell.name,
            description: cell.description ?? null,
            rendererSource: cell.code,
            deps: cell.deps ?? {},
            isActive: true,
            updatedAt: new Date(),
          },
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
   * DELETE /cells/:typeKey
   * Uninstall a cell (soft-delete widget_definition).
   */
  app.delete("/cells/:typeKey", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const typeKey = c.req.param("typeKey");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "workspaceId query param is required" }, 400);
    }
    const userId = c.get("userId");
    if (!(await verifyWorkspaceAccess(userId, workspaceId))) {
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
            eq(widgetDefinitions.workspaceId, workspaceId)
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
