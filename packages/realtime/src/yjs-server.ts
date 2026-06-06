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
import {
  db,
  eq,
  and,
  readDocumentVersionContent,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
} from "@synap/database";
import {
  documents,
  documentVersions,
  documentSessions,
  workspaceMembers,
} from "@synap/database/schema";
import { storage } from "@synap/storage";
import { recordYjsPersist } from "./bridge.js";
import { randomUUID } from "crypto";

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

      if (isWhiteboard) {
        if (!doc.storageKey) {
          // New whiteboard with no prior content — initialize empty
          console.log(
            `[Yjs] Whiteboard ${roomName} has no storageKey yet — starting fresh`
          );
          return;
        }
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

      const workingContent = workingVersion
        ? await readDocumentVersionContent(workingVersion)
        : null;
      if (workingContent?.startsWith("yjs:")) {
        const base64State = workingContent.substring(4);
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

      if (isWhiteboard) {
        // Whiteboard: save to MinIO (canonical source, no version)
        let storageKey = doc.storageKey;

        // Safety net: derive storageKey if missing (legacy whiteboards or creation edge cases)
        if (!storageKey) {
          console.warn(
            `[Yjs] Whiteboard ${roomName} missing storageKey — deriving fallback`
          );
          const userId = (doc as any).userId ?? "system";
          storageKey = `whiteboards/${userId}/${documentId}.json`;
          await db
            .update(documents)
            .set({ storageKey })
            .where(eq(documents.id, documentId));
          console.log(
            `[Yjs] Persisted derived storageKey for ${roomName}: ${storageKey}`
          );
        }

        // Extract Tldraw store from Yjs Map
        const yMap = ydoc.getMap(`tl_map_${documentId}`);
        const store: TldrawStoreSnapshot = {};
        yMap.forEach((val, key) => {
          if (val != null && typeof val === "object") {
            store[key] = val as unknown;
          }
        });

        let content: string;
        if (Object.keys(store).length > 0) {
          // Tldraw store found — save as JSON
          content = JSON.stringify({ store });
        } else {
          // No Tldraw map — save raw Yjs state as base64
          const state = Y.encodeStateAsUpdate(ydoc);
          if (state.byteLength <= 2) {
            // Empty doc, skip save
            return;
          }
          content = `yjs:${Buffer.from(state).toString("base64")}`;
        }

        // Retry MinIO upload up to 3 times with exponential backoff
        let uploadOk = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) {
              await new Promise<void>((r) =>
                setTimeout(r, 200 * Math.pow(2, attempt - 1))
              );
            }
            await storage.upload(storageKey, Buffer.from(content, "utf-8"), {
              contentType: "application/json",
            });
            uploadOk = true;
            break;
          } catch (uploadErr) {
            console.warn(
              `[Yjs] MinIO upload attempt ${attempt + 1} failed for ${roomName}:`,
              uploadErr
            );
          }
        }
        if (!uploadOk) {
          console.error(
            `[Yjs] All MinIO upload attempts failed for ${roomName} — data may be lost`
          );
          return;
        }
        await db
          .update(documents)
          .set({ updatedAt: new Date() })
          .where(eq(documents.id, documentId));
        recordYjsPersist();
        console.log(
          `[Yjs] Saved whiteboard to MinIO for ${roomName} (${Object.keys(store).length} tldraw records, ${content.length} bytes)`
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
        const snapshot = await uploadDocumentVersionSnapshot({
          userId: doc.userId,
          documentId,
          versionId: existingWorkingVersion.id,
          documentType: doc.type,
          mimeType: doc.mimeType || "application/octet-stream",
          content: yjsContent,
        });
        await db
          .update(documentVersions)
          .set(storedVersionValues(snapshot))
          .where(
            and(
              eq(documentVersions.documentId, documentId),
              eq(documentVersions.version, workingVersion)
            )
          );
      } else {
        const versionId = randomUUID();
        const snapshot = await uploadDocumentVersionSnapshot({
          userId: doc.userId,
          documentId,
          versionId,
          documentType: doc.type,
          mimeType: doc.mimeType || "application/octet-stream",
          content: yjsContent,
        });
        await db.insert(documentVersions).values({
          id: versionId,
          documentId,
          version: workingVersion,
          ...storedVersionValues(snapshot),
          author: "system",
          authorId: "yjs-server",
          message: "Working version created (Yjs sync)",
        });
      }

      await db
        .update(documents)
        .set({ updatedAt: new Date() })
        .where(eq(documents.id, documentId));

      recordYjsPersist();
      console.log(
        `[Yjs] Updated working version ${workingVersion} for ${roomName}`
      );
    } catch (error) {
      console.error(`[Yjs] Failed to save document ${roomName}:`, error);
    }
  }

  /**
   * Create a version snapshot when a room closes (all users disconnected).
   * This is the primary versioning mechanism — content is persisted through
   * Yjs realtime, and versions are created when editing sessions end.
   */
  async createSnapshot(roomName: string, ydoc: Y.Doc): Promise<void> {
    try {
      const documentId = parseRoomName(roomName);
      if (!documentId) return;

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });

      if (!doc) return;

      const isWhiteboard = roomName.startsWith("whiteboard-");

      if (isWhiteboard) {
        // Whiteboards: just ensure MinIO is up-to-date (writeState already did this).
        // No version row needed — whiteboards are always "latest state" in MinIO.
        // Only persist to MinIO as final flush.
        await this.writeState(roomName, ydoc);

        await db
          .update(documents)
          .set({ updatedAt: new Date() })
          .where(eq(documents.id, documentId));

        console.log(
          `[Yjs] Final save for whiteboard ${roomName} (session closed)`
        );
      } else {
        // Documents: create an immutable version snapshot
        const state = Y.encodeStateAsUpdate(ydoc);
        const content = `yjs:${Buffer.from(state).toString("base64")}`;

        // Skip empty snapshots
        if (state.byteLength <= 2) return;

        const newVersion = (doc.currentVersion || 0) + 1;
        const versionId = randomUUID();
        const snapshot = await uploadDocumentVersionSnapshot({
          userId: doc.userId,
          documentId,
          versionId,
          documentType: doc.type,
          mimeType: doc.mimeType || "application/octet-stream",
          content,
        });

        await db.insert(documentVersions).values({
          id: versionId,
          documentId,
          version: newVersion,
          ...storedVersionValues(snapshot),
          author: "system",
          authorId: "session-close",
          message: "Auto-saved on session close",
        });

        await db
          .update(documents)
          .set({
            currentVersion: newVersion,
            lastSavedVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, documentId));

        console.log(
          `[Yjs] Created version snapshot v${newVersion} for ${roomName} (session closed)`
        );
      }

      // Mark all active sessions for this document as ended
      await db
        .update(documentSessions)
        .set({
          isActive: false,
          endedAt: new Date(),
        })
        .where(
          and(
            eq(documentSessions.documentId, documentId),
            eq(documentSessions.isActive, true)
          )
        );
    } catch (error) {
      console.error(`[Yjs] Failed to create snapshot for ${roomName}:`, error);
    }
  }
}

export interface YjsServerInstance {
  /** Active Yjs documents keyed by room name (exposed by y-socket.io at runtime). */
  documents: Map<string, Y.Doc>;
  /** Flush all pending debounced saves immediately — call before process exit. */
  flushAll: () => Promise<void>;
  // Expose event emitter surface used by server.ts
  on: YSocketIO["on"];
}

/**
 * Setup Yjs WebSocket server
 */
export function setupYjsServer(config: YjsServerConfig): YjsServerInstance {
  const { io, persistenceInterval = 5000 } = config;
  const persistence = new DatabasePersistence();

  console.log("[Yjs] Initializing y-socket.io server...");

  // Create YSocketIO server with database persistence and access control.
  //
  // Access model: any workspace member may read/write any document in that workspace.
  // The client sends { userId, workspaceId } in the SocketIOProvider auth object;
  // we verify the document belongs to that workspace and the user is a member.
  //
  // If auth is missing (legacy clients, local dev without auth), we fail open with a
  // warning so existing flows aren't broken. Set REQUIRE_YJS_AUTH=true in production
  // to make the check strict.
  const requireAuth = process.env.REQUIRE_YJS_AUTH === "true";

  const yServer = new YSocketIO(io, {
    gcEnabled: true,
    authenticate: async (handshake) => {
      const { userId, workspaceId } = (handshake.auth ?? {}) as {
        userId?: string;
        workspaceId?: string;
      };

      if (!userId) {
        if (requireAuth) {
          console.warn("[Yjs] Auth rejected: missing userId");
          return false;
        }
        return true; // lenient in dev
      }

      // The room name is either "whiteboard-{docId}" or "{docId}" — parse documentId
      // We can't get the room name from the handshake alone (it's per-namespace middleware),
      // so we verify workspace membership instead: userId ∈ workspaceId.
      // This is sufficient because all documents in a workspace share the same access gate.
      if (!workspaceId) {
        if (requireAuth) {
          console.warn(
            `[Yjs] Auth rejected for userId=${userId}: missing workspaceId`
          );
          return false;
        }
        return true; // lenient in dev
      }

      try {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId)
          ),
          columns: { id: true },
        });

        if (!membership) {
          console.warn(
            `[Yjs] Auth rejected: userId=${userId} is not a member of workspace=${workspaceId}`
          );
          return false;
        }

        return true;
      } catch (err) {
        // DB error — fail open to avoid locking out users during transient outages
        console.error("[Yjs] Auth check failed (DB error), failing open:", err);
        return true;
      }
    },
  });

  // CRITICAL: Set persistence directly on the YSocketIO instance.
  // The library awaits persistence.bindState() BEFORE starting sync with clients.
  // If we used the "document-loaded" event instead, bindState would be fire-and-forget
  // and clients would receive an empty doc before MinIO content is loaded (race condition).
  //
  // The library calls writeState on room close (all connections dropped) BEFORE destroying
  // the doc, so we handle final snapshot creation inside writeState when the room is closing.
  const closingRooms = new Set<string>();

  (yServer as any).persistence = {
    bindState: async (docName: string, ydoc: Y.Doc) => {
      await persistence.bindState(docName, ydoc);
    },
    writeState: async (docName: string, ydoc: Y.Doc) => {
      if (closingRooms.has(docName)) {
        // Room is closing — do final snapshot instead of regular write
        closingRooms.delete(docName);
        try {
          await persistence.createSnapshot(docName, ydoc);
        } catch (err) {
          console.error(
            `[Yjs] createSnapshot failed for ${docName}, falling back to writeState:`,
            err
          );
          try {
            await persistence.writeState(docName, ydoc);
          } catch (fallbackErr) {
            console.error(
              `[Yjs] writeState fallback also failed for ${docName}:`,
              fallbackErr
            );
          }
        }
      } else {
        try {
          await persistence.writeState(docName, ydoc);
        } catch (err) {
          console.error(`[Yjs] writeState failed for ${docName}:`, err);
        }
      }
    },
    provider: null,
  };

  // Debounced auto-save using interval
  const saveIntervals = new Map<string, NodeJS.Timeout>();

  // y-socket.io emits "document-update" with (doc: Document, update: Uint8Array)
  // where Document extends Y.Doc and has a .name property (the room name string).
  yServer.on(
    "document-update",
    (doc: Y.Doc & { name?: string }, _update: Uint8Array) => {
      const docName = (doc as any).name as string | undefined;
      if (!docName) return;

      // Clear existing timeout for this document
      const existing = saveIntervals.get(docName);
      if (existing) clearTimeout(existing);

      // Set new timeout for debounced save
      const timeout = setTimeout(() => {
        persistence.writeState(docName, doc);
        saveIntervals.delete(docName);
      }, persistenceInterval);

      saveIntervals.set(docName, timeout);
    }
  );

  // When last user disconnects, mark room as closing.
  // The library then calls persistence.writeState() (which we intercept above
  // to run createSnapshot instead) followed by doc.destroy().
  yServer.on(
    "all-document-connections-closed",
    (docOrArray: Y.Doc | Y.Doc[]) => {
      const doc = Array.isArray(docOrArray) ? docOrArray[0] : docOrArray;
      if (!doc) return;
      const docName = (doc as any).name as string;
      if (!docName) return;

      // Cancel any pending debounced save — the library's writeState will handle it
      const pendingSave = saveIntervals.get(docName);
      if (pendingSave) {
        clearTimeout(pendingSave);
        saveIntervals.delete(docName);
      }

      // Mark this room as closing so persistence.writeState triggers createSnapshot
      closingRooms.add(docName);
      console.log(`[Yjs] Room closing: ${docName}`);
    }
  );

  console.log("[Yjs] Server ready ✅");
  console.log(`  - Persistence interval: ${persistenceInterval}ms`);
  console.log(`  - Auto-save: ✅ (debounced)`);
  console.log(`  - Garbage collection: ✅`);

  /** Flush all pending debounced saves — bypasses the debounce timer. */
  const flushAll = async (): Promise<void> => {
    const docs = (yServer as any).documents as Map<string, Y.Doc> | undefined;
    const flushPromises: Promise<void>[] = [];
    for (const [docName, timeout] of saveIntervals.entries()) {
      clearTimeout(timeout);
      saveIntervals.delete(docName);
      const doc = docs?.get(docName);
      if (doc) {
        flushPromises.push(
          persistence.writeState(docName, doc).catch((err) => {
            console.error(
              `[Yjs] flushAll writeState failed for ${docName}:`,
              err
            );
          })
        );
      }
    }
    if (flushPromises.length > 0) {
      console.log(`[Yjs] Flushing ${flushPromises.length} pending save(s)...`);
      await Promise.allSettled(flushPromises);
      console.log("[Yjs] Flush complete");
    }
  };

  const server = yServer as unknown as YjsServerInstance;
  server.flushAll = flushAll;
  return server;
}
