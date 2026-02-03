/**
 * Yjs Server - CRDT-based document synchronization
 *
 * Provides conflict-free collaboration for:
 * - Whiteboards (Tldraw + Yjs)
 * - Documents (Monaco + Yjs)
 * - Any CRDT-based content
 *
 * Uses y-socket.io for Socket.IO integration
 */

import * as Y from "yjs";
import { YSocketIO } from "y-socket.io/dist/server";
import type { Server as SocketIOServer } from "socket.io";
import { db, eq, desc, and } from "@synap/database";
import { views, documents, documentVersions } from "@synap/database/schema";
import { storage } from "@synap/storage";

export interface YjsServerConfig {
  io: SocketIOServer;
  persistenceInterval?: number; // ms between saves
}

/**
 * Custom persistence adapter for database storage
 */
class DatabasePersistence {
  /**
   * Load Y.Doc from database
   */
  async bindState(roomName: string, ydoc: Y.Doc): Promise<void> {
    try {
      const [type, id] = roomName.split("-");

      if (type !== "whiteboard" && type !== "document") {
        console.warn(`[Yjs] Invalid room type: ${type}`);
        return;
      }

      // Get view to find document
      const view = await db.query.views.findFirst({
        where: eq(views.id, id),
      });

      if (!view?.documentId) {
        console.log(`[Yjs] New document for room: ${roomName}`);
        return;
      }

      // Get document to check current version
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, view.documentId),
      });

      if (!doc) return;

      // Try to load from working version (currentVersion) first
      const workingVersion = await db.query.documentVersions.findFirst({
        where: and(
          eq(documentVersions.documentId, view.documentId),
          eq(documentVersions.version, doc.currentVersion)
        ),
      });

      if (workingVersion && workingVersion.content.startsWith("yjs:")) {
        // Extract base64-encoded Yjs state from working version
        const base64State = workingVersion.content.substring(4);
        const state = Buffer.from(base64State, "base64");
        Y.applyUpdate(ydoc, state);
        console.log(
          `[Yjs] Loaded working version ${doc.currentVersion} for ${roomName}`
        );
      } else {
        // Fallback: Load from storage (current content)
        // This handles documents that don't have Yjs state yet
        if (doc.storageKey) {
          try {
            const contentBuffer = await storage.downloadBuffer(doc.storageKey);
            const content = contentBuffer.toString("utf-8");

            // For whiteboards, content is Tldraw JSON - convert to Yjs if needed
            // For now, we'll let Yjs initialize fresh and sync from storage
            console.log(
              `[Yjs] No working version found, will initialize fresh for ${roomName}`
            );
          } catch (error) {
            console.warn(
              `[Yjs] Failed to load from storage for ${roomName}:`,
              error
            );
          }
        }
      }
    } catch (error) {
      console.error(`[Yjs] Failed to load document ${roomName}:`, error);
    }
  }

  /**
   * Save Y.Doc to database
   */
  async writeState(roomName: string, ydoc: Y.Doc): Promise<void> {
    try {
      const [type, id] = roomName.split("-");

      if (type !== "whiteboard" && type !== "document") return;

      // Get view to find document
      const view = await db.query.views.findFirst({
        where: eq(views.id, id),
      });

      if (!view?.documentId) {
        console.warn(`[Yjs] No document found for view ${id}`);
        return;
      }

      // Get current document
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, view.documentId),
      });

      if (!doc) return;

      // Encode Y.Doc as binary state
      const state = Y.encodeStateAsUpdate(ydoc);
      const base64State = Buffer.from(state).toString("base64");
      const yjsContent = `yjs:${base64State}`;

      const workingVersion = doc.currentVersion;

      // Update working version (don't create new - N+1 pattern)
      // During realtime editing, we update the same working version
      const existingWorkingVersion = await db.query.documentVersions.findFirst({
        where: and(
          eq(documentVersions.documentId, view.documentId),
          eq(documentVersions.version, workingVersion)
        ),
      });

      if (existingWorkingVersion) {
        // Update existing working version
        await db
          .update(documentVersions)
          .set({
            content: yjsContent,
          })
          .where(
            and(
              eq(documentVersions.documentId, view.documentId),
              eq(documentVersions.version, workingVersion)
            )
          );
      } else {
        // Working version doesn't exist - create it (shouldn't happen, but safety check)
        console.warn(
          `[Yjs] Working version ${workingVersion} not found, creating it for ${roomName}`
        );
        await db.insert(documentVersions).values({
          documentId: view.documentId,
          version: workingVersion,
          content: yjsContent,
          author: "system",
          authorId: "yjs-server",
          message: "Working version created (Yjs sync)",
        });
      }

      // Note: Storage update during Yjs sync is deferred to explicit save operations
      // This keeps the sync fast and avoids complex content extraction from Yjs
      // Storage will be updated when user explicitly saves (via document-snapshots worker)

      // Update document timestamp (version number stays the same)
      await db
        .update(documents)
        .set({
          updatedAt: new Date(),
        })
        .where(eq(documents.id, view.documentId));

      console.log(
        `[Yjs] Updated working version ${workingVersion} for ${roomName}`
      );
    } catch (error) {
      console.error(`[Yjs] Failed to save document ${roomName}:`, error);
    }
  }
}

/**
 * Setup Yjs WebSocket server
 */
export function setupYjsServer(
  config: YjsServerConfig
): YSocketIO & { documents: Map<string, Y.Doc> } {
  const { io, persistenceInterval = 10000 } = config;
  const persistence = new DatabasePersistence();

  console.log("[Yjs] Initializing y-socket.io server...");

  // Create YSocketIO server with database persistence
  const yServer = new YSocketIO(io, {
    gcEnabled: true,
    // Note: persistInterval not in YSocketIOConfiguration, using event-based persistence
  });

  // Hook into document lifecycle for custom persistence
  yServer.on("document-loaded", (docName: string, doc: Y.Doc) => {
    persistence.bindState(docName, doc);
  });

  // Debounced auto-save using interval
  const saveIntervals = new Map<string, NodeJS.Timeout>();

  yServer.on("document-update", (docName: string, doc: Y.Doc) => {
    // Clear existing timeout for this document
    const existing = saveIntervals.get(docName);
    if (existing) clearTimeout(existing);

    // Set new timeout for debounced save
    const timeout = setTimeout(() => {
      persistence.writeState(docName, doc);
      saveIntervals.delete(docName);
    }, persistenceInterval);

    saveIntervals.set(docName, timeout);
  });

  console.log("[Yjs] Server ready ✅");
  console.log(`  - Persistence interval: ${persistenceInterval}ms`);
  console.log(`  - Auto-save: ✅ (debounced)`);
  console.log(`  - Garbage collection: ✅`);

  // Expose documents map for HTTP endpoint access
  return yServer as YSocketIO & { documents: Map<string, Y.Doc> };
}
