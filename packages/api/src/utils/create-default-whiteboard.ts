/**
 * Utility function to create a default whiteboard for a workspace
 *
 * This is used both:
 * 1. By the executor when a new workspace is created
 * 2. As a fallback in workspaces.get when fetching an existing workspace without a main whiteboard
 */

import { randomUUID } from "crypto";
import { getDb } from "@synap/database";
import {
  documents,
  documentVersions,
  views,
  workspaces,
} from "@synap/database/schema";
import { eq } from "@synap/database";
import { getViewCategory } from "@synap-core/types";

export interface CreateDefaultWhiteboardResult {
  status: "created" | "skipped" | "error";
  message: string;
  whiteboardId?: string;
  documentId?: string;
  error?: string;
}

/**
 * Create default whiteboard for a workspace if it doesn't exist
 *
 * @param workspaceId - The workspace ID
 * @param userId - The user ID (workspace owner or member with write access)
 * @returns Result indicating if whiteboard was created or skipped
 */
export async function ensureDefaultWhiteboard(
  workspaceId: string,
  userId: string
): Promise<CreateDefaultWhiteboardResult> {
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
        error: "WORKSPACE_NOT_FOUND",
      };
    }

    // Check if main whiteboard already exists
    const existingMainWhiteboardId = (workspace.settings as any)
      ?.mainWhiteboardId;
    if (existingMainWhiteboardId) {
      // Verify the whiteboard still exists
      const existingView = await db.query.views.findFirst({
        where: eq(views.id, existingMainWhiteboardId),
      });
      if (existingView) {
        return {
          status: "skipped",
          message: "Main whiteboard already exists",
          whiteboardId: existingMainWhiteboardId,
          documentId: existingView.documentId || undefined,
        };
      }
      // If view doesn't exist but ID is in settings, we'll create a new one and update settings
    }

    // 1. Create document for whiteboard content
    const documentId = randomUUID();
    const [document] = await db
      .insert(documents)
      .values({
        id: documentId,
        userId,
        workspaceId,
        title: "Main Whiteboard",
        type: "whiteboard",
        storageUrl: "",
        storageKey: `whiteboards/${workspaceId}/main/${Date.now()}`,
        size: 0,
        currentVersion: 1,
      } as any)
      .returning();

    // 2. Create initial document version with empty Tldraw content
    // Empty Tldraw structure: just an empty object (Tldraw will initialize properly)
    const emptyTldrawContent = {};
    await db.insert(documentVersions).values({
      documentId: document.id,
      version: 1,
      content: JSON.stringify(emptyTldrawContent),
      author: "system",
      authorId: userId,
      message: "Initial whiteboard",
    });

    // 3. Create view (whiteboard type)
    const viewId = randomUUID();
    const category = getViewCategory("whiteboard");
    const [view] = await db
      .insert(views)
      .values({
        id: viewId,
        workspaceId,
        userId,
        type: "whiteboard",
        category,
        name: "Main Whiteboard",
        description: "Default whiteboard for this workspace",
        documentId: document.id,
        metadata: {
          entityCount: 0,
          createdBy: userId,
          isMain: true,
        },
      } as any)
      .returning();

    // 4. Update workspace settings to include mainWhiteboardId
    const currentSettings = (workspace.settings || {}) as any;
    const updatedSettings = {
      ...currentSettings,
      mainWhiteboardId: viewId,
    };

    await db
      .update(workspaces)
      .set({
        settings: updatedSettings,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId));

    return {
      status: "created",
      message: "Default whiteboard created",
      whiteboardId: viewId,
      documentId: document.id,
    };
  } catch (error: any) {
    return {
      status: "error",
      message: `Failed to create default whiteboard: ${error.message}`,
      error: error.message,
    };
  }
}
