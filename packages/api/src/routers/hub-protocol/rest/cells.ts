/**
 * Hub Protocol REST — cells (marketplace install/uninstall/list lifecycle)
 */

import { z } from "zod";
import { getDb, and, eq, isNull, or } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import { emitHubRealtimeEvent } from "../../../utils/domain-event-bridge.js";
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

      emitHubRealtimeEvent({
        eventType: "widget_definition.create.completed",
        subjectId: typeKey,
        userId: userId ?? "",
        data: { id: typeKey, typeKey, workspaceId: workspaceId ?? undefined, changeType: "created" },
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

    // npm package name: optional scope (@org/pkg) + lowercase-kebab name, no URLs/protocols
    const NPM_PKG_NAME_RE =
      /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
    // Version string: semver range or "latest" — permissive but blocks blank/URL values
    const NPM_VERSION_RE = /^[a-zA-Z0-9^~><= .*|-]{1,64}$/;

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
            if (!val) return;
            const entries = Object.entries(val);
            if (entries.length > 30) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "deps must have at most 30 entries",
              });
              return;
            }
            for (const [pkg, version] of entries) {
              if (!NPM_PKG_NAME_RE.test(pkg)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `Invalid package name in deps: "${pkg}"`,
                });
              }
              if (!NPM_VERSION_RE.test(version)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `Invalid version string for "${pkg}": "${version}"`,
                });
              }
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

    const { name, rendererSource, workspaceId, description, defaultSize, deps } =
      parsed.data;
    const userId = c.get("userId");

    // Only gate workspace access when a specific workspace is targeted
    if (workspaceId && !(await verifyWorkspaceAccess(userId, workspaceId))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }

    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const typeKey = parsed.data.typeKey ?? `generated:${slug}`;

    const values = {
      typeKey,
      workspaceId: workspaceId ?? null,
      name,
      description: description ?? null,
      category: "installed" as const,
      rendererType: "frame" as const,
      rendererSource,
      deps: (deps ?? {}) as Record<string, string>,
      configSchema: {},
      defaultConfig: {},
      defaultSize: defaultSize ?? { w: 6, h: 4 },
      isActive: true,
      trustLevel: "generated" as const,
    };

    try {
      const db = await getDb();
      let changeType: "created" | "updated" = "created";

      if (workspaceId) {
        // Workspace-scoped: unique constraint on (typeKey, workspaceId) works normally
        const result = await db
          .insert(widgetDefinitions)
          .values(values)
          .onConflictDoUpdate({
            target: [widgetDefinitions.typeKey, widgetDefinitions.workspaceId],
            set: {
              name,
              description: description ?? null,
              rendererSource,
              deps: (deps ?? {}) as Record<string, string>,
              isActive: true,
              updatedAt: new Date(),
            },
          })
          .returning({ id: widgetDefinitions.id, updatedAt: widgetDefinitions.updatedAt, createdAt: widgetDefinitions.createdAt });
        const row = result[0];
        if (row && row.updatedAt && row.createdAt && row.updatedAt.getTime() !== row.createdAt.getTime()) {
          changeType = "updated";
        }
      } else {
        // Pod-global (workspaceId IS NULL): PostgreSQL treats NULLs as distinct
        // in unique indexes, so onConflictDoUpdate won't fire. Manual upsert.
        const updated = await db
          .update(widgetDefinitions)
          .set({
            name,
            description: description ?? null,
            rendererSource,
            deps: (deps ?? {}) as Record<string, string>,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(widgetDefinitions.typeKey, typeKey),
              isNull(widgetDefinitions.workspaceId)
            )
          )
          .returning({ id: widgetDefinitions.id });
        if (updated.length === 0) {
          await db.insert(widgetDefinitions).values(values);
        } else {
          changeType = "updated";
        }
      }

      emitHubRealtimeEvent({
        eventType: changeType === "created"
          ? "widget_definition.create.completed"
          : "widget_definition.update.completed",
        subjectId: typeKey,
        userId: userId ?? "",
        data: { id: typeKey, typeKey, workspaceId: workspaceId ?? undefined, changeType },
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
