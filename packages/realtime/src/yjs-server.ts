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
import { db, eq, desc } from "@synap/database";
import { views, documents, documentVersions } from "@synap/database/schema";

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

      // Get latest document version with Yjs state
      const latestVersion = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.documentId, view.documentId),
        orderBy: [desc(documentVersions.version)],
      });

      if (!latestVersion) return;

      // Check if content is Yjs binary state
      if (latestVersion.content.startsWith("yjs:")) {
        // Extract base64-encoded Yjs state
        const base64State = latestVersion.content.substring(4);
        const state = Buffer.from(base64State, "base64");
        Y.applyUpdate(ydoc, state);
        console.log(`[Yjs] Loaded persisted state for ${roomName}`);
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
      const content = `yjs:${base64State}`;

      const newVersion = (doc.currentVersion || 0) + 1;

      // Create new version
      await db.insert(documentVersions).values({
        documentId: view.documentId,
        version: newVersion,
        content,
        author: "system",
        authorId: "yjs-server",
        message: "Auto-save (Yjs sync)",
      });

      // Update document version
      await db
        .update(documents)
        .set({
          currentVersion: newVersion,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, view.documentId));

      console.log(`[Yjs] Saved ${roomName} (version ${newVersion})`);
    } catch (error) {
      console.error(`[Yjs] Failed to save document ${roomName}:`, error);
    }
  }
}

/**
 * Setup Yjs WebSocket server
 */
export function setupYjsServer(
  config: YjsServerConfig,
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
