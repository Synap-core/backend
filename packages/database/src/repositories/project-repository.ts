/**
 * Project Repository
 *
 * Handles all project CRUD operations with automatic event emission
 */

import { eq, and } from "drizzle-orm";
import { projects } from "../schema/projects.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Project, NewProject } from "../schema/projects.js";

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  status?: "active" | "archived" | "completed";
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  userId: string;
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
      } as NewProject)
      .returning();

    // Emit completed event
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
      } as Partial<NewProject>)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning();

    if (!project) {
      throw new Error("Project not found");
    }

    // Emit completed event
    await this.emitCompleted("update", project, userId);

    return project;
  }

  /**
   * Delete a project
   * Emits: projects.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning({ id: projects.id });

    if (result.length === 0) {
      throw new Error("Project not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
