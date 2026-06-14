/**
 * Utility function to create default views for a workspace
 *
 * This is used by the executor when a new workspace is created.
 * Creates starter views to help users get started.
 *
 * Located in @synap/database to avoid circular dependencies (both @synap/api and @synap/jobs can use it)
 */

import { getDb, sql } from "../client-pg.js";
import { views, workspaces } from "../schema/index.js";
import { eq } from "drizzle-orm";
import { ProfileRepository } from "../repositories/profile-repository.js";
import { ViewRepository } from "../repositories/view-repository.js";
import { EventRepository } from "../repositories/event-repository.js";

export interface EnsureDefaultViewsResult {
  status: "created" | "skipped" | "error";
  message: string;
  viewsCreated: number;
  viewIds?: string[];
  error?: string;
}

/**
 * Create default views for a workspace if they don't exist
 *
 * Creates task-oriented starter views. Workspace Home bento defaults are owned
 * by the Browser client so there is one canonical home layout.
 *
 * @param workspaceId - The workspace ID
 * @param userId - The user ID (workspace owner or member with write access)
 * @returns Result indicating if views were created or skipped
 */
export async function ensureDefaultViews(
  workspaceId: string,
  userId: string
): Promise<EnsureDefaultViewsResult> {
  const db = await getDb();

  try {
    // Check if workspace exists
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });

    if (!workspace) {
      return {
        status: "error",
        message: `Workspace ${workspaceId} not found`,
        viewsCreated: 0,
        error: "WORKSPACE_NOT_FOUND",
      };
    }

    // Get task profile if available (optional — task views are only created when profile exists)
    const profileRepo = new ProfileRepository(db);
    const taskProfile = await profileRepo.getBySlug("task", workspaceId);

    // Check if default views already exist
    const allWorkspaceViews = await db.query.views.findMany({
      where: eq(views.workspaceId, workspaceId),
    });

    const existingViews = allWorkspaceViews.filter((v) => v.userId === userId);

    const hasAllTasks = existingViews.some((v) => v.name === "All Tasks");
    const hasTaskBoard = existingViews.some((v) => v.name === "Task Board");
    // Skip if task views are done, or when the task profile is not available.
    // The Browser renders the canonical Home bento fallback when no pod Home
    // config exists, so the backend intentionally does not seed one here.
    const taskViewsDone = !taskProfile || (hasAllTasks && hasTaskBoard);
    if (taskViewsDone) {
      return {
        status: "skipped",
        message: "Default views already exist",
        viewsCreated: 0,
        viewIds: existingViews
          .filter((v) => v.name === "All Tasks" || v.name === "Task Board")
          .map((v) => v.id),
      };
    }

    // Create views using ViewRepository (emits events)
    const eventRepo = new EventRepository(sql);
    const viewRepo = new ViewRepository(db, eventRepo);

    const createdViewIds: string[] = [];

    // 1. Create "All Tasks" table view (only when task profile exists)
    if (taskProfile && !hasAllTasks) {
      const allTasksView = await viewRepo.create(
        {
          type: "table",
          name: "All Tasks",
          description: "View all tasks in a table",
          workspaceId,
          userId,
          scopeProfileIds: [taskProfile.id],
          scopeMode: "explicit",
          query: {
            filters: [],
            sorts: [{ field: "createdAt", direction: "desc" }],
            search: "",
            limit: 100,
            offset: 0,
          },
          config: {
            visibleColumns: [
              "title",
              "status",
              "priority",
              "dueDate",
              "assignee",
            ],
            columnOrder: ["title", "status", "priority", "dueDate", "assignee"],
          },
        },
        userId
      );
      createdViewIds.push(allTasksView.id);
    }

    // 2. Create "Task Board" kanban view (only when task profile exists)
    if (taskProfile && !hasTaskBoard) {
      const taskBoardView = await viewRepo.create(
        {
          type: "kanban",
          name: "Task Board",
          description: "Kanban board for tasks",
          workspaceId,
          userId,
          scopeProfileIds: [taskProfile.id],
          scopeMode: "explicit",
          query: {
            filters: [],
            sorts: [],
            search: "",
            limit: 1000, // Kanban shows more items
            offset: 0,
          },
          config: {
            groupByColumnId: "status",
            kanbanColumns: [
              { id: "todo", value: "todo", label: "To Do", order: 0 },
              {
                id: "in-progress",
                value: "in-progress",
                label: "In Progress",
                order: 1,
              },
              { id: "done", value: "done", label: "Done", order: 2 },
              {
                id: "cancelled",
                value: "cancelled",
                label: "Cancelled",
                order: 3,
              },
            ],
          },
        },
        userId
      );
      createdViewIds.push(taskBoardView.id);
    }

    return {
      status: "created",
      message: `Created ${createdViewIds.length} default view(s)`,
      viewsCreated: createdViewIds.length,
      viewIds: createdViewIds,
    };
  } catch (error: unknown) {
    const err = error as Error & {
      code?: string;
      detail?: string;
      constraint?: string;
    };
    console.error(
      `[ensureDefaultViews] Error creating default views for workspace ${workspaceId}:`,
      {
        error: err.message,
        stack: err.stack,
        code: err.code,
        detail: err.detail,
        constraint: err.constraint,
      }
    );
    return {
      status: "error",
      message: `Failed to create default views: ${err.message}`,
      viewsCreated: 0,
      error: err.message,
    };
  }
}
