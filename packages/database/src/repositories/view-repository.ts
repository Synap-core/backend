/**
 * View Repository
 *
 * Handles all view CRUD operations with automatic event emission
 * Views include whiteboards, timelines, kanban boards, etc.
 */

import { eq, and } from "drizzle-orm";
import { views } from "../schema/views.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { View, NewView } from "../schema/views.js";

export interface CreateViewInput {
  id?: string;
  type:
    | "whiteboard"
    | "timeline"
    | "kanban"
    | "table"
    | "calendar"
    | "list"
    | "grid"
    | "gallery"
    | "graph"
    | "mindmap"
    | "gantt";
  name: string;
  description?: string;
  documentId?: string;
  workspaceId: string;
  userId: string;
  // NEW: Scope profiles (required for structured views)
  scopeProfileIds?: string[];
  scopeMode?: "explicit" | "observed";
  // NEW: Consolidated query
  query?: Record<string, unknown>; // EntityQuery
  // NEW: Render config (overrides only)
  config?: Record<string, unknown>;
}

export interface UpdateViewInput {
  name?: string;
  description?: string;
  scopeProfileIds?: string[];
  scopeMode?: "explicit" | "observed";
  query?: Record<string, unknown>;
  config?: Record<string, unknown>;
  schemaSnapshot?: Record<string, unknown>;
  snapshotUpdatedAt?: Date;
}

export class ViewRepository extends BaseRepository<
  View,
  CreateViewInput,
  UpdateViewInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "view" });
  }

  /**
   * Create a new view
   * Emits: views.create.completed
   */
  async create(data: CreateViewInput, userId: string): Promise<View> {
    // Determine category from type
    const category = ["whiteboard", "mindmap"].includes(data.type)
      ? "canvas"
      : "structured";

    // Validate scopeProfileIds for structured views
    if (
      category === "structured" &&
      (!data.scopeProfileIds || data.scopeProfileIds.length === 0)
    ) {
      throw new Error("scopeProfileIds is required for structured views");
    }

    const [view] = await this.db
      .insert(views)
      .values({
        id: data.id,
        type: data.type,
        category,
        name: data.name,
        description: data.description,
        documentId: data.documentId,
        workspaceId: data.workspaceId,
        userId,
        // NEW: Scope profiles
        scopeProfileIds: data.scopeProfileIds,
        scopeMode: data.scopeMode || "explicit",
        // NEW: Consolidated query
        query: data.query || {},
        // NEW: Render config (overrides)
        config: data.config || {},
        // Metadata (for entity orders, etc.)
        metadata: {},
      } as NewView)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", view, userId);

    return view;
  }

  /**
   * Update an existing view
   * Emits: views.update.completed
   */
  async update(
    id: string,
    data: UpdateViewInput,
    userId: string
  ): Promise<View> {
    const updateData: Partial<NewView> = {
      updatedAt: new Date(),
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.scopeProfileIds !== undefined) {
      // Validate scopeProfileIds for structured views
      const view = await this.db.query.views.findFirst({
        where: eq(views.id, id),
      });
      if (
        view &&
        view.category === "structured" &&
        (!data.scopeProfileIds || data.scopeProfileIds.length === 0)
      ) {
        throw new Error("scopeProfileIds cannot be empty for structured views");
      }
      updateData.scopeProfileIds = data.scopeProfileIds;
    }
    if (data.scopeMode !== undefined) updateData.scopeMode = data.scopeMode;
    if (data.query !== undefined) updateData.query = data.query;
    if (data.config !== undefined) updateData.config = data.config;
    if (data.schemaSnapshot !== undefined)
      updateData.schemaSnapshot = data.schemaSnapshot;
    if (data.snapshotUpdatedAt !== undefined)
      updateData.snapshotUpdatedAt = data.snapshotUpdatedAt;

    const [view] = await this.db
      .update(views)
      .set(updateData)
      .where(and(eq(views.id, id), eq(views.userId, userId)))
      .returning();

    if (!view) {
      throw new Error("View not found");
    }

    // Emit completed event
    await this.emitCompleted("update", view, userId);

    return view;
  }

  /**
   * Delete a view
   * Emits: views.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(views)
      .where(and(eq(views.id, id), eq(views.userId, userId)))
      .returning({ id: views.id });

    if (result.length === 0) {
      throw new Error("View not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
