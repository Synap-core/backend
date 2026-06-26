/**
 * Project Repository
 *
 * Handles all project CRUD operations with automatic event emission.
 * Projects are first-class table rows (projects pgTable), NOT entities.
 */

import { eq, and } from "drizzle-orm";
import { projects } from "../schema/projects.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Project } from "../schema/projects.js";

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  status?: "active" | "archived" | "completed";
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  userId: string;
  workspaceId?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: "active" | "archived" | "completed";
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export class ProjectRepository extends BaseRepository<
  Project,
  CreateProjectInput,
  UpdateProjectInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "project", pluralName: "projects" });
  }

  /**
   * Create a new project
   * Emits: projects.create.completed
   */
  async create(data: CreateProjectInput, userId: string): Promise<Project> {
    const [project] = await this.db
      .insert(projects)
      .values({
        id: data.id,
        name: data.name,
        description: data.description,
        status: data.status || "active",
        settings: data.settings || {},
        metadata: data.metadata || {},
        userId,
        workspaceId: data.workspaceId ?? null,
      })
      .returning();

    await this.emitCompleted("create", project, userId);
    return project;
  }

  /**
   * Update an existing project
   * Emits: projects.update.completed
   */
  async update(
    id: string,
    data: UpdateProjectInput,
    userId: string
  ): Promise<Project> {
    const [project] = await this.db
      .update(projects)
      .set({
        name: data.name,
        description: data.description,
        status: data.status,
        settings: data.settings,
        metadata: data.metadata,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning();

    if (!project) {
      throw new Error("Project not found");
    }

    await this.emitCompleted("update", project, userId);
    return project;
  }

  /**
   * Delete a project
   * Emits: projects.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    // Ownership is not re-checked here — the caller (tRPC router) gates via
    // checkPermissionOrPropose. Workspace members may delete projects they
    // did not create if the RBAC policy allows it.
    const result = await this.db
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id });

    if (result.length === 0) {
      throw new Error("Project not found");
    }

    await this.emitCompleted(
      "delete",
      { id } as Partial<Project> & { id: string },
      userId
    );
  }
}
