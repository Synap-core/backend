/**
 * Workspace Repository
 *
 * Handles all workspace CRUD operations with automatic event emission
 */

import { eq } from "drizzle-orm";
import { workspaces } from "../schema/workspaces.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Workspace, NewWorkspace } from "../schema/workspaces.js";

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  slug: string;
  ownerId: string;
  settings?: Record<string, unknown>;
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  settings?: Record<string, unknown>;
}

export class WorkspaceRepository extends BaseRepository<
  Workspace,
  CreateWorkspaceInput,
  UpdateWorkspaceInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "workspace" });
  }

  /**
   * Create a new workspace
   * Emits: workspaces.create.completed
   */
  async create(data: CreateWorkspaceInput, userId: string): Promise<Workspace> {
    const [workspace] = await this.db
      .insert(workspaces)
      .values({
        id: data.id,
        name: data.name,
        slug: data.slug,
        ownerId: data.ownerId,
        settings: data.settings || {},
      } as NewWorkspace)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", workspace, userId);

    return workspace;
  }

  /**
   * Update an existing workspace
   * Emits: workspaces.update.completed
   */
  async update(
    id: string,
    data: UpdateWorkspaceInput,
    userId: string
  ): Promise<Workspace> {
    const [workspace] = await this.db
      .update(workspaces)
      .set({
        name: data.name,
        slug: data.slug,
        settings: data.settings,
        updatedAt: new Date(),
      } as Partial<NewWorkspace>)
      .where(eq(workspaces.id, id))
      .returning();

    if (!workspace) {
      throw new Error("Workspace not found");
    }

    // Emit completed event
    await this.emitCompleted("update", workspace, userId);

    return workspace;
  }

  /**
   * Delete a workspace
   * Emits: workspaces.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(workspaces)
      .where(eq(workspaces.id, id))
      .returning({ id: workspaces.id });

    if (result.length === 0) {
      throw new Error("Workspace not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
