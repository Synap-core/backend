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
import { getDb } from "../client-pg.js";
import {
  documents,
  documentVersions,
  views,
  workspaces,
} from "../schema/index.js";
import { eq, and } from "drizzle-orm";
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

    // Deduplication: if mainWhiteboardId is not set but a whiteboard view already
    // exists for this workspace (e.g. previous creation succeeded but settings
    // update failed), adopt it instead of creating a duplicate.
    if (!existingMainWhiteboardId) {
      const orphanedView = await db.query.views.findFirst({
        where: and(
          eq(views.workspaceId, workspaceId),
          eq(views.type, "whiteboard" as any)
        ),
      });
      if (orphanedView) {
        // Repair: link existing whiteboard in workspace settings
        const currentSettings = (workspace.settings || {}) as any;
        await db
          .update(workspaces)
          .set({
            settings: { ...currentSettings, mainWhiteboardId: orphanedView.id },
            updatedAt: new Date(),
          })
          .where(eq(workspaces.id, workspaceId));

        console.log(
          `[ensureDefaultWhiteboard] Adopted orphaned whiteboard ${orphanedView.id} for workspace ${workspaceId}`
        );
        return {
          status: "skipped",
          message: "Adopted existing whiteboard (repaired settings)",
          whiteboardId: orphanedView.id,
          documentId: orphanedView.documentId || undefined,
        };
      }
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

    // Import storage (cycle is now broken: database → storage → core ✅)
    // We use dynamic import to keep database package lightweight, but it's now a proper dependency
    const { storage } = await import("@synap/storage");

    // Build standardized storage path (same pattern as other documents)
    const storageKey = storage.buildPath(
      userId,
      "whiteboard",
      documentId,
      "json"
    );

    // Upload to MinIO storage (required - no fallback)
    // Retry logic for transient network errors
    const maxRetries = 3;
    let uploadResult: { url: string; path: string; size: number } | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        uploadResult = await storage.upload(storageKey, tldrawBuffer, {
          contentType: "application/json",
        });
        break; // Success, exit retry loop
      } catch (error: any) {
        lastError = error;
        console.warn(
          `[ensureDefaultWhiteboard] MinIO upload attempt ${attempt}/${maxRetries} failed:`,
          error.message
        );

        // If not the last attempt, wait before retrying (exponential backoff)
        if (attempt < maxRetries) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    if (!uploadResult) {
      throw new Error(
        `Failed to upload whiteboard to MinIO after ${maxRetries} attempts: ${lastError?.message || "Unknown error"}`
      );
    }

    let document;
    try {
      // Insert document - type is required in schema
      const [insertedDocument] = await db
        .insert(documents)
        .values({
          id: documentId,
          userId,
          workspaceId,
          title: "Main Whiteboard",
          type: documentType, // Required field - schema defines it as NOT NULL
          // All documents use MinIO storage (unified approach)
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
    const yjsRoomId = `whiteboard-${document.id}`;
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
        yjsRoomId,
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
    console.error(
      `[ensureDefaultWhiteboard] Error creating whiteboard for workspace ${workspaceId}:`,
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
      message: `Failed to create default whiteboard: ${error.message}`,
      error: error.message,
    };
  }
}
