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
import { db, eq, and } from "@synap/database";
import { documents, documentVersions } from "@synap/database/schema";
import { storage } from "@synap/storage";

export interface YjsServerConfig {
  io: SocketIOServer;
  persistenceInterval?: number; // ms between saves
}

/**
 * Parse room name to get documentId.
 * - "whiteboard-{documentId}" -> documentId (whiteboard room)
 * - "{documentId}" (raw UUID) -> documentId (document room, e.g. TipTap)
 */
function parseRoomName(roomName: string): string | null {
  if (roomName.startsWith("whiteboard-")) {
    return roomName.slice("whiteboard-".length);
  }
  // Raw documentId (e.g. for TipTap documents)
  if (roomName.length > 0) {
    return roomName;
  }
  return null;
}

/** Tldraw store snapshot format: Record<id, record> */
type TldrawStoreSnapshot = Record<string, unknown>;

/**
 * Custom persistence adapter: MinIO for whiteboards (canonical), document_versions for others.
 */
class DatabasePersistence {
  /**
   * Load Y.Doc: whiteboard rooms from MinIO (Tldraw JSON), others from document_versions.
   */
  async bindState(roomName: string, ydoc: Y.Doc): Promise<void> {
    try {
      const documentId = parseRoomName(roomName);
      if (!documentId) {
        console.warn(`[Yjs] Invalid room name: ${roomName}`);
        return;
      }

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });

      if (!doc) {
        console.log(`[Yjs] New document for room: ${roomName}`);
        return;
      }

      const isWhiteboard = roomName.startsWith("whiteboard-");

      if (isWhiteboard && doc.storageKey) {
        // Whiteboard: load from MinIO (canonical source)
        try {
          const contentBuffer = await storage.downloadBuffer(doc.storageKey);
          const content = contentBuffer.toString("utf-8");

          // Legacy: content might be yjs:base64 from old document_versions backfill
          if (content.startsWith("yjs:")) {
            const state = Buffer.from(content.substring(4), "base64");
            Y.applyUpdate(ydoc, state);
            console.log(
              `[Yjs] Loaded whiteboard from MinIO (legacy Yjs) for ${roomName}`
            );
            return;
          }

          const parsed = JSON.parse(content || "{}") as {
            store?: TldrawStoreSnapshot;
          };
          const store = parsed.store ?? parsed;
          if (typeof store === "object" && store !== null) {
            const yMap = ydoc.getMap(`tl_map_${documentId}`);
            ydoc.transact(() => {
              for (const [key, val] of Object.entries(store)) {
                if (val != null && typeof val === "object") {
                  yMap.set(key, val);
                }
              }
            });
            console.log(
              `[Yjs] Loaded whiteboard from MinIO for ${roomName} (${Object.keys(store).length} records)`
            );
          }
        } catch (error) {
          console.warn(
            `[Yjs] Failed to load whiteboard from MinIO for ${roomName}:`,
            error
          );
        }
        return;
      }

      // Non-whiteboard: load from document_versions (legacy)
      const workingVersion = await db.query.documentVersions.findFirst({
        where: and(
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.version, doc.currentVersion)
        ),
      });

      if (workingVersion?.content.startsWith("yjs:")) {
        const base64State = workingVersion.content.substring(4);
        const state = Buffer.from(base64State, "base64");
        Y.applyUpdate(ydoc, state);
        console.log(
          `[Yjs] Loaded working version ${doc.currentVersion} for ${roomName}`
        );
      } else if (doc.storageKey) {
        // Fallback: try MinIO for markdown/text
        try {
          const contentBuffer = await storage.downloadBuffer(doc.storageKey);
          const content = contentBuffer.toString("utf-8");
          // Raw Y.Doc state (base64) – future: support MinIO for markdown
          if (content.startsWith("yjs:")) {
            const state = Buffer.from(content.substring(4), "base64");
            Y.applyUpdate(ydoc, state);
          }
        } catch {
          // Ignore – will initialize fresh
        }
      }
    } catch (error) {
      console.error(`[Yjs] Failed to load document ${roomName}:`, error);
    }
  }

  /**
   * Save Y.Doc: whiteboard rooms to MinIO (canonical, no version), others to document_versions.
   * Realtime save every 30s – working state only, no version creation.
   */
  async writeState(roomName: string, ydoc: Y.Doc): Promise<void> {
    try {
      const documentId = parseRoomName(roomName);
      if (!documentId) return;

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });

      if (!doc) return;

      const isWhiteboard = roomName.startsWith("whiteboard-");

      if (isWhiteboard && doc.storageKey) {
        // Whiteboard: save to MinIO (canonical source, no version)
        const yMap = ydoc.getMap(`tl_map_${documentId}`);
        const store: TldrawStoreSnapshot = {};
        yMap.forEach((val, key) => {
          if (val != null && typeof val === "object") {
            store[key] = val as unknown;
          }
        });
        const tldrawJson = JSON.stringify({ store });
        await storage.upload(doc.storageKey, Buffer.from(tldrawJson, "utf-8"), {
          contentType: "application/json",
        });
        await db
          .update(documents)
          .set({ updatedAt: new Date() })
          .where(eq(documents.id, documentId));
        console.log(
          `[Yjs] Saved whiteboard to MinIO for ${roomName} (${Object.keys(store).length} records)`
        );
        return;
      }

      // Non-whiteboard: save to document_versions (legacy)
      const state = Y.encodeStateAsUpdate(ydoc);
      const base64State = Buffer.from(state).toString("base64");
      const yjsContent = `yjs:${base64State}`;
      const workingVersion = doc.currentVersion;

      const existingWorkingVersion = await db.query.documentVersions.findFirst({
        where: and(
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.version, workingVersion)
        ),
      });

      if (existingWorkingVersion) {
        await db
          .update(documentVersions)
          .set({ content: yjsContent })
          .where(
            and(
              eq(documentVersions.documentId, documentId),
              eq(documentVersions.version, workingVersion)
            )
          );
      } else {
        await db.insert(documentVersions).values({
          documentId,
          version: workingVersion,
          content: yjsContent,
          author: "system",
          authorId: "yjs-server",
          message: "Working version created (Yjs sync)",
        });
      }

      await db
        .update(documents)
        .set({ updatedAt: new Date() })
        .where(eq(documents.id, documentId));

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
  const { io, persistenceInterval = 5000 } = config;
  const persistence = new DatabasePersistence();

  console.log("[Yjs] Initializing y-socket.io server...");

  // Create YSocketIO server with database persistence
  const yServer = new YSocketIO(io, {
    gcEnabled: true,
    // Note: persistInterval not in YSocketIOConfiguration, using event-based persistence
  });

  // Hook into document lifecycle for custom persistence.
  // bindState is async; the library may answer sync-step-1 before it completes (see ENTITY_PANEL_LAG_AND_REALTIME_AUDIT.md).
  yServer.on("document-loaded", (docName: string, doc: Y.Doc) => {
    void persistence.bindState(docName, doc);
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
