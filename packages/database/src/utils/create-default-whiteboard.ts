/**
 * Utility function to create a default whiteboard for a workspace
 *
 * This is used both:
 * 1. By the executor when a new workspace is created
 * 2. As a fallback in workspaces.get when fetching an existing workspace without a main whiteboard
 *
 * Located in @synap/database to avoid circular dependencies (both @synap/api and @synap/jobs can use it)
 */

import { randomUUID } from "crypto";
import { getDb, sql } from "../client-pg.js";
import {
  documents,
  documentVersions,
  views,
  workspaces,
} from "../schema/index.js";
import { eq } from "drizzle-orm";
import type {
  DocumentType,
  DocumentMetadata,
} from "../types/document-types.js";

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
    const documentType: DocumentType = "whiteboard";

    // Type-safe metadata
    const documentMetadata: DocumentMetadata = {
      isMainWhiteboard: true,
    };

    // 1a. Upload initial whiteboard content to MinIO storage (unified storage for all documents)
    // Empty Tldraw structure: just an empty object (Tldraw will initialize properly)
    const emptyTldrawContent = {};
    const tldrawJson = JSON.stringify(emptyTldrawContent);
    const tldrawBuffer = Buffer.from(tldrawJson, "utf-8");

    // Import storage dynamically (to avoid circular dependency)
    // @synap/database cannot depend on @synap/storage in dependencies (cycle: database -> storage -> types -> database)
    // Dynamic import works at runtime - TypeScript types available via devDependency
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { storage } = await import("@synap/storage");

    // Build standardized storage path (same pattern as other documents)
    const storageKey = storage.buildPath(
      userId,
      "whiteboard",
      documentId,
      "json"
    );

    // Upload to MinIO storage
    const uploadResult = await storage.upload(storageKey, tldrawBuffer, {
      contentType: "application/json",
    });

    let document;
    try {
      // Check if 'type' column exists in database
      // This allows the code to work both before and after migration
      const columnCheck = await sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'documents' AND column_name = 'type'
      `;

      const hasTypeColumn =
        Array.isArray(columnCheck) && columnCheck.length > 0;

      const [insertedDocument] = await db
        .insert(documents)
        .values({
          id: documentId,
          userId,
          workspaceId,
          title: "Main Whiteboard",
          // Conditionally include 'type' if column exists
          ...(hasTypeColumn ? { type: documentType } : {}),
          // All documents now use MinIO storage (unified approach)
          storageUrl: uploadResult.url,
          storageKey: uploadResult.path,
          size: uploadResult.size,
          mimeType: "application/json",
          currentVersion: 1,
          metadata: documentMetadata,
        } as any)
        .returning();

      if (!insertedDocument) {
        throw new Error("Document insert returned no rows");
      }
      document = insertedDocument;
    } catch (insertError: any) {
      // Log full error details for debugging
      console.error("[ensureDefaultWhiteboard] Document insert failed:", {
        error: insertError.message,
        code: insertError.code,
        detail: insertError.detail,
        constraint: insertError.constraint,
        table: insertError.table,
        values: { documentId, userId, workspaceId },
      });
      throw insertError;
    }

    // 2. Create initial document version snapshot (from storage content)
    // Versions are snapshots of storage content for history/queryability
    await db.insert(documentVersions).values({
      documentId: document.id,
      version: 1,
      content: tldrawJson, // Snapshot of storage content
      author: "system",
      authorId: userId,
      message: "Initial whiteboard",
    });

    // 3. Create view (whiteboard type)
    const viewId = randomUUID();
    // Use 'canvas' category for whiteboard (from @synap-core/types)
    const category = "canvas";
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

    // Verify view was created
    if (!view) {
      throw new Error("Failed to create whiteboard view");
    }

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
