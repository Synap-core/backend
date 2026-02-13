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
 * Creates:
 * - "Home" (bento view - workspace dashboard)
 * - "All Tasks" (table view)
 * - "Task Board" (kanban view)
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

    // Get task profile (system profile)
    const profileRepo = new ProfileRepository(db);
    const taskProfile = await profileRepo.getBySlug("task");

    if (!taskProfile) {
      return {
        status: "skipped",
        message:
          "Task profile not found - system profiles may not be seeded yet",
        viewsCreated: 0,
      };
    }

    // Check if default views already exist
    const allWorkspaceViews = await db.query.views.findMany({
      where: eq(views.workspaceId, workspaceId),
    });

    const existingViews = allWorkspaceViews.filter((v) => v.userId === userId);

    const hasAllTasks = existingViews.some((v) => v.name === "All Tasks");
    const hasTaskBoard = existingViews.some((v) => v.name === "Task Board");
    const hasHome = allWorkspaceViews.some(
      (v) =>
        v.type === "bento" && (v.metadata as any)?.homeScope === "workspace"
    );

    if (hasAllTasks && hasTaskBoard && hasHome) {
      return {
        status: "skipped",
        message: "Default views already exist",
        viewsCreated: 0,
        viewIds: existingViews
          .filter(
            (v) =>
              v.name === "All Tasks" ||
              v.name === "Task Board" ||
              (v.type === "bento" &&
                (v.metadata as any)?.homeScope === "workspace")
          )
          .map((v) => v.id),
      };
    }

    // Create views using ViewRepository (emits events)
    const eventRepo = new EventRepository(sql);
    const viewRepo = new ViewRepository(db, eventRepo);

    const createdViewIds: string[] = [];

    // 1. Create "All Tasks" table view
    if (!hasAllTasks) {
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

    // 2. Create "Task Board" kanban view
    if (!hasTaskBoard) {
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

    // 3. Create "Home" bento view (workspace dashboard)
    if (!hasHome) {
      const DEFAULT_HOME_CONFIG = {
        layout: "bento",
        breakpoints: {
          lg: { cols: 12, rowHeight: 100, gap: 16 },
          md: { cols: 8, rowHeight: 100, gap: 16 },
          sm: { cols: 4, rowHeight: 100, gap: 16 },
        },
        blocks: [
          // Top row: Welcome (left), Workspace card (center), Tabs (right)
          {
            id: "welcome",
            kind: "widget",
            widgetType: "welcome",
            pos: { x: 0, y: 0, w: 4, h: 2 },
          },
          {
            id: "workspace-card",
            kind: "widget",
            widgetType: "workspace-info",
            pos: { x: 4, y: 0, w: 4, h: 2 },
          },
          {
            id: "tabs",
            kind: "widget",
            widgetType: "home-tabs",
            pos: { x: 8, y: 0, w: 4, h: 2 },
          },
          // Bottom row: Calendar (2/3 width), Feed (1/3 width)
          {
            id: "calendar",
            kind: "widget",
            widgetType: "calendar",
            pos: { x: 0, y: 2, w: 8, h: 8 },
          },
          {
            id: "feed",
            kind: "widget",
            widgetType: "feed",
            pos: { x: 8, y: 2, w: 4, h: 8 },
          },
        ],
      };

      const homeView = await viewRepo.create(
        {
          type: "bento",
          name: "Home",
          description: "Workspace home dashboard",
          workspaceId,
          userId,
          config: DEFAULT_HOME_CONFIG,
          metadata: { homeScope: "workspace" },
        },
        userId
      );
      createdViewIds.push(homeView.id);
    }

    return {
      status: "created",
      message: `Created ${createdViewIds.length} default view(s)`,
      viewsCreated: createdViewIds.length,
      viewIds: createdViewIds,
    };
  } catch (error: any) {
    console.error(
      `[ensureDefaultViews] Error creating default views for workspace ${workspaceId}:`,
      {
        error: error.message,
        stack: error.stack,
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
      }
    );
    return {
      status: "error",
      message: `Failed to create default views: ${error.message}`,
      viewsCreated: 0,
      error: error.message,
    };
  }
}
