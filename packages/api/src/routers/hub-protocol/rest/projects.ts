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
  eq,
  and,
  or,
  isNull,
  isNotNull,
  desc,
  ProjectRepository,
  EventRepository,
  sql,
} from "@synap/database";
import { type HubHono } from "./_shared.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";

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
