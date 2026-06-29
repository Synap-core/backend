/**
 * Hub REST — Projects (projects TABLE, NOT entities)
 *
 * CRUD for first-class project rows in the `projects` pgTable.
 * Auth: Hub Protocol API key (Bearer). All writes go through governance.
 */

import { z } from "zod";
import {
  db,
  projects,
  entities,
  workspaces,
  eq,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  desc,
  drizzleSql,
  ProjectRepository,
  EventRepository,
  sql,
} from "@synap/database";
import { buildDigestSummary, type HubHono } from "./_shared.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";
import {
  accessScopeWhere,
  projectLensWhere,
} from "../../../utils/project-scope.js";

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(["active", "archived", "completed"]).default("active"),
  settings: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  workspaceId: z.string().uuid().optional(),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(["active", "archived", "completed"]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function registerProjectsRoutes(app: HubHono): void {
  // List projects for the authenticated user
  app.get("/projects", async (c) => {
    const userId = c.get("userId");
    const status = c.req.query("status") ?? undefined;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 100);

    const conditions: ReturnType<typeof eq>[] = [
      // Dual-mode scoping (parity with tRPC projectsRouter):
      // Pod-wide projects (NULL workspace): only visible to their owner
      // Workspace-scoped projects: visible to all workspace members
      or(
        and(isNull(projects.workspaceId), eq(projects.userId, userId)),
        and(
          isNotNull(projects.workspaceId),
          userVisibleWhere(projects.workspaceId, userId)
        )
      )!,
    ];
    if (status) conditions.push(eq(projects.status, status as any));

    const rows = await db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt))
      .limit(limit);

    return c.json(rows);
  });

  // Project data digest — deterministic "understand existing data before
  // acting" briefing aggregated across the project's linked workspaces (entities
  // filed into the project via belongs_to_project). Registered BEFORE
  // /projects/:id so the `/:projectId/digest` literal suffix resolves cleanly.
  // Scoping = the canonical entity floor (accessScopeWhere) AND the project lens
  // (projectLensWhere) — the lens only narrows, never widens (no leak).
  app.get("/projects/:projectId/digest", async (c) => {
    const userId = c.get("userId");
    const parsed = z
      .object({ projectId: z.string().uuid() })
      .safeParse({ projectId: c.req.param("projectId") });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid projectId", details: parsed.error.issues },
        400
      );
    }
    const { projectId } = parsed.data;

    // Access gate + name resolution — same visibility predicate as GET /projects/:id.
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        or(
          and(isNull(projects.workspaceId), eq(projects.userId, userId)),
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, userId)
          )
        )!
      ),
      columns: { id: true, name: true },
    });
    if (!project) return c.json({ error: "Project not found" }, 404);

    const baseWhere = and(
      isNull(entities.deletedAt),
      accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId,
      }),
      projectLensWhere(entities.id, projectId)
    );

    const [countRows, byWorkspaceRows, recentRows] = await Promise.all([
      db
        .select({
          profileSlug: entities.type,
          count: drizzleSql<number>`cast(count(*) as integer)`,
        })
        .from(entities)
        .where(baseWhere)
        .groupBy(entities.type),
      db
        .select({
          workspaceId: entities.workspaceId,
          count: drizzleSql<number>`cast(count(*) as integer)`,
        })
        .from(entities)
        .where(baseWhere)
        .groupBy(entities.workspaceId),
      db
        .select({
          id: entities.id,
          title: entities.title,
          profileSlug: entities.type,
          workspaceId: entities.workspaceId,
          updatedAt: entities.updatedAt,
        })
        .from(entities)
        .where(baseWhere)
        .orderBy(desc(entities.updatedAt))
        .limit(10),
    ]);

    const counts: Record<string, number> = {};
    for (const row of countRows) counts[row.profileSlug] = row.count;
    const total = countRows.reduce((sum, r) => sum + r.count, 0);

    // Resolve workspace names for the byWorkspace breakdown (null = pod-wide).
    const wsIds = byWorkspaceRows
      .map((r) => r.workspaceId)
      .filter((id): id is string => id != null);
    const wsNameRows = wsIds.length
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds))
      : [];
    const wsNameById = new Map(wsNameRows.map((w) => [w.id, w.name]));
    const byWorkspace = byWorkspaceRows.map((r) => ({
      workspaceId: r.workspaceId,
      name: r.workspaceId
        ? (wsNameById.get(r.workspaceId) ?? "Unknown")
        : "Pod-wide",
      total: r.count,
    }));

    const keyEntities = recentRows.map((r) => ({
      id: r.id,
      title: r.title,
      profileSlug: r.profileSlug,
      workspaceId: r.workspaceId,
      updatedAt: r.updatedAt,
    }));

    const summary = buildDigestSummary(
      `Project '${project.name}'`,
      total,
      counts,
      keyEntities,
      byWorkspace.length > 0
        ? `spanning ${byWorkspace.length} workspace${
            byWorkspace.length === 1 ? "" : "s"
          }`
        : undefined
    );

    return c.json({
      projectId,
      name: project.name,
      total,
      counts,
      byWorkspace,
      keyEntities,
      summary,
    });
  });

  // Get a single project
  app.get("/projects/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");

    const row = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, id),
        or(
          and(isNull(projects.workspaceId), eq(projects.userId, userId)),
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, userId)
          )
        )!
      ),
    });

    if (!row) return c.json({ error: "Project not found" }, 404);
    return c.json(row);
  });

  // Create a project
  app.post("/projects", async (c) => {
    const userId = c.get("userId");
    const body = CreateProjectSchema.parse(await c.req.json());

    const perm = await checkPermissionOrPropose({
      userId,
      workspaceId: body.workspaceId ?? undefined,
      subjectType: "project",
      action: "create",
      data: { name: body.name },
    });

    if ("denied" in perm && perm.denied) {
      return c.json({ error: perm.reason }, 403);
    }
    if ("proposalId" in perm) {
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);
    }

    const eventRepo = new EventRepository(sql);
    const repo = new ProjectRepository(db, eventRepo);

    const row = await repo.create(
      {
        name: body.name,
        description: body.description,
        status: body.status,
        settings: body.settings,
        metadata: body.metadata,
        userId,
        workspaceId: body.workspaceId ?? null,
      },
      userId
    );

    return c.json(row, 201);
  });

  // Update a project
  app.patch("/projects/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const body = UpdateProjectSchema.parse(await c.req.json());

    const perm = await checkPermissionOrPropose({
      userId,
      subjectType: "project",
      action: "update",
      data: { id },
    });

    if ("denied" in perm && perm.denied) {
      return c.json({ error: perm.reason }, 403);
    }
    if ("proposalId" in perm) {
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);
    }

    const eventRepo = new EventRepository(sql);
    const repo = new ProjectRepository(db, eventRepo);

    try {
      const row = await repo.update(id, body, userId);
      return c.json(row);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  // Delete a project
  app.delete("/projects/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");

    const perm = await checkPermissionOrPropose({
      userId,
      subjectType: "project",
      action: "delete",
      data: { id },
    });

    if ("denied" in perm && perm.denied) {
      return c.json({ error: perm.reason }, 403);
    }
    if ("proposalId" in perm) {
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);
    }

    const eventRepo = new EventRepository(sql);
    const repo = new ProjectRepository(db, eventRepo);

    try {
      await repo.delete(id, userId);
      return c.json({ status: "deleted" });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });
}
