/**
 * Workspace Repository
 *
 * Handles all workspace CRUD operations with automatic event emission
 */

import { eq, sql } from "drizzle-orm";
import { workspaces, type WorkspaceSettings } from "../schema/workspaces.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Workspace, NewWorkspace } from "../schema/workspaces.js";

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  ownerId: string;
  settings?: Record<string, unknown>;
}

export interface UpdateWorkspaceInput {
  name?: string;
  settings?: Record<string, unknown>;
}

export class WorkspaceRepository extends BaseRepository<
  Workspace,
  CreateWorkspaceInput,
  UpdateWorkspaceInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "workspaces" });
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
   * Shallow-merge a partial settings object into the workspace's existing settings.
   * Uses Postgres `||` JSONB operator — atomic, no read-then-write needed.
   * Top-level keys in `patch` overwrite the corresponding keys in settings.
   * Keys not present in `patch` are preserved unchanged.
   *
   * For nested merges (e.g. updating one key inside profileBentoViewIds) the
   * caller should build the merged sub-object and pass it as a single key:
   *   mergeSettings(id, { profileBentoViewIds: { ...existing, deal: viewId } }, userId)
   */
  async mergeSettings(
    id: string,
    patch: Partial<WorkspaceSettings>,
    userId: string
  ): Promise<Workspace> {
    const [workspace] = await this.db
      .update(workspaces)
      .set({
        settings: sql`${workspaces.settings} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      } as any)
      .where(eq(workspaces.id, id))
      .returning();

    if (!workspace) {
      throw new Error("Workspace not found");
    }

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
