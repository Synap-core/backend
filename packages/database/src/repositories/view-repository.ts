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
  type: "whiteboard" | "timeline" | "kanban" | "table" | "calendar";
  name: string;
  documentId?: string;
  workspaceId: string;
  config?: Record<string, unknown>;
  userId: string;
}

export interface UpdateViewInput {
  name?: string;
  config?: Record<string, unknown>;
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

    const [view] = await this.db
      .insert(views)
      .values({
        id: data.id,
        type: data.type,
        category,
        name: data.name,
        documentId: data.documentId,
        workspaceId: data.workspaceId,
        metadata: data.config || {},
        userId,
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
    const [view] = await this.db
      .update(views)
      .set({
        name: data.name,
        config: data.config,
        updatedAt: new Date(),
      } as Partial<NewView>)
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
