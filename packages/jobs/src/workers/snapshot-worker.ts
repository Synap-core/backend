/**
 * Snapshot Workers
 *
 * Document and whiteboard snapshot/restore/autosave workers.
 * Ported from Inngest functions: document-snapshots.ts, whiteboard-snapshots.ts,
 * document-persistence.ts
 */

import type PgBoss from "pg-boss";
import {
  db,
  eq,
  readDocumentVersionBuffer,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
} from "@synap/database";
import {
  documents,
  documentVersions,
  documentSessions,
  views,
} from "@synap/database/schema";
import { storage } from "@synap/storage";
import { broadcastSuccess } from "../utils/realtime-broadcast.js";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "snapshot-worker" });

// ============================================================================
// Document Snapshot
// ============================================================================

export async function handleDocumentSnapshot(
  job: PgBoss.Job<{
    documentId: string;
    message?: string;
    userId: string;
  }>
): Promise<void> {
  const { documentId, message, userId } = job.data;

  const document = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!document) throw new Error(`Document ${documentId} not found`);

  const buffer = await storage.downloadBuffer(document.storageKey!);
  const content = buffer.toString("utf-8");

  const newVersion = (document.currentVersion || 0) + 1;
  const versionId = randomUUID();
  const snapshot = await uploadDocumentVersionSnapshot({
    userId,
    documentId,
    versionId,
    documentType: document.type,
    mimeType: document.mimeType,
    content,
  });

  const [version] = await db
    .insert(documentVersions)
    .values({
      id: versionId,
      documentId,
      version: newVersion,
      ...storedVersionValues(snapshot),
      message: message || `Version ${newVersion}`,
      author: "user",
      authorId: userId,
    })
    .returning();

  await db
    .update(documents)
    .set({
      lastSavedVersion: newVersion,
      currentVersion: newVersion,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId));

  await broadcastSuccess(userId, "document.snapshot.saved", {
    documentId,
    versionId: version.id,
    version: newVersion,
    message: version.message,
  });

  logger.info({ documentId, version: newVersion }, "Document snapshot saved");
}

// ============================================================================
// Document Restore
// ============================================================================

export async function handleDocumentRestore(
  job: PgBoss.Job<{
    documentId: string;
    versionId: string;
    userId: string;
  }>
): Promise<void> {
  const { documentId, versionId, userId } = job.data;

  const version = await db.query.documentVersions.findFirst({
    where: eq(documentVersions.id, versionId),
  });
  if (!version) throw new Error(`Version ${versionId} not found`);
  if (version.documentId !== documentId)
    throw new Error("Version does not belong to this document");

  const document = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!document) throw new Error(`Document ${documentId} not found`);

  const restoredBuffer = await readDocumentVersionBuffer(version);
  const metadata = await storage.upload(document.storageKey!, restoredBuffer, {
    contentType: version.mimeType || document.mimeType || "text/plain",
  });

  const newVersion = (document.currentVersion || 0) + 1;

  await db
    .update(documents)
    .set({
      currentVersion: newVersion,
      storageUrl: metadata.url,
      storageKey: metadata.path,
      size: metadata.size,
      mimeType: version.mimeType || document.mimeType,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId));

  await broadcastSuccess(userId, "document.restored", {
    documentId,
    restoredFromVersion: version.version,
    currentVersion: newVersion,
  });

  logger.info(
    { documentId, restoredFromVersion: version.version },
    "Document restored"
  );
}

// ============================================================================
// Document Auto-Save (cron)
// ============================================================================

export async function handleDocumentAutoSave(): Promise<void> {
  const activeSessions = await db.query.documentSessions.findMany({
    where: eq(documentSessions.isActive, true),
    limit: 100,
  });

  if (activeSessions.length === 0) return;

  await Promise.allSettled(
    activeSessions.map(async (session) => {
      const document = await db.query.documents.findFirst({
        where: eq(documents.id, session.documentId),
      });
      if (!document) return;

      const buffer = await storage.downloadBuffer(document.storageKey!);
      const content = buffer.toString("utf-8");
      const newVersion = (document.currentVersion || 0) + 1;
      const versionId = randomUUID();
      const snapshot = await uploadDocumentVersionSnapshot({
        userId: document.userId,
        documentId: session.documentId,
        versionId,
        documentType: document.type,
        mimeType: document.mimeType,
        content,
      });

      await db.insert(documentVersions).values({
        id: versionId,
        documentId: session.documentId,
        version: newVersion,
        ...storedVersionValues(snapshot),
        message: "Auto-save checkpoint",
        author: "system",
        authorId: "auto-save",
      });

      await db
        .update(documents)
        .set({
          currentVersion: newVersion,
          lastSavedVersion: newVersion,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, session.documentId));
    })
  );

  logger.info(
    { sessions: activeSessions.length },
    "Document auto-save complete"
  );
}

// ============================================================================
// Document Persistence (working state backup, cron)
// ============================================================================

export async function handleDocumentPersistence(): Promise<void> {
  const activeSessions = await db.query.documentSessions.findMany({
    where: eq(documentSessions.isActive, true),
    limit: 50,
  });

  if (activeSessions.length === 0) return;

  const REALTIME_URL = process.env.REALTIME_URL || "http://localhost:4001";

  await Promise.allSettled(
    activeSessions.map(async (session) => {
      const yjsRoomId = session.documentId;
      const response = await fetch(`${REALTIME_URL}/yjs/${yjsRoomId}/state`, {
        headers: {
          "X-Internal-Request": "true",
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 404) return; // Room not active
        throw new Error(`Realtime server error: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const base64State = Buffer.from(buffer).toString("base64");

      await db
        .update(documents)
        .set({ workingState: base64State, workingStateUpdatedAt: new Date() })
        .where(eq(documents.id, session.documentId));
    })
  );

  logger.info(
    { sessions: activeSessions.length },
    "Document persistence complete"
  );
}

// ============================================================================
// Whiteboard Snapshot
// ============================================================================

export async function handleWhiteboardSnapshot(
  job: PgBoss.Job<{
    viewId: string;
    documentId: string;
    yjsRoomId: string;
    message?: string;
    userId: string;
  }>
): Promise<void> {
  const { viewId, documentId, yjsRoomId, message, userId } = job.data;

  const REALTIME_URL = process.env.REALTIME_URL || "http://localhost:4001";
  const response = await fetch(`${REALTIME_URL}/yjs/${yjsRoomId}/state`, {
    headers: {
      "X-Internal-Request": "true",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok)
    throw new Error(`Realtime server error: ${response.status}`);

  const buffer = await response.arrayBuffer();
  const base64State = Buffer.from(buffer).toString("base64");

  const document = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!document) throw new Error(`Document ${documentId} not found`);

  const savedVersion = document.currentVersion;
  const newWorkingVersion = savedVersion + 1;

  const versionId = randomUUID();
  const snapshot = await uploadDocumentVersionSnapshot({
    userId,
    documentId,
    versionId,
    documentType: document.type,
    mimeType: document.mimeType || "application/json",
    content: base64State,
  });

  const [version] = await db
    .insert(documentVersions)
    .values({
      id: versionId,
      documentId,
      version: savedVersion,
      ...storedVersionValues(snapshot),
      message: message || "Snapshot",
      author: "user",
      authorId: userId,
    })
    .returning();

  await db
    .update(documents)
    .set({
      lastSavedVersion: savedVersion,
      currentVersion: newWorkingVersion,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId));

  await broadcastSuccess(userId, "whiteboard.snapshot.saved", {
    viewId,
    versionId: version.id,
    version: savedVersion,
    message,
  });

  logger.info({ viewId, version: savedVersion }, "Whiteboard snapshot saved");
}

// ============================================================================
// Whiteboard Restore
// ============================================================================

export async function handleWhiteboardRestore(
  job: PgBoss.Job<{
    viewId: string;
    versionId: string;
    yjsRoomId: string;
    content: string;
    userId: string;
  }>
): Promise<void> {
  const { viewId, versionId, yjsRoomId, content, userId } = job.data;

  const view = await db.query.views.findFirst({
    where: eq(views.id, viewId),
  });
  if (!view) throw new Error(`View ${viewId} not found`);

  const REALTIME_URL = process.env.REALTIME_URL || "http://localhost:4001";
  const response = await fetch(`${REALTIME_URL}/yjs/${yjsRoomId}/restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Request": "true",
    },
    body: JSON.stringify({ state: content }),
  });
  if (!response.ok)
    throw new Error(`Realtime server error: ${response.status}`);

  await broadcastSuccess(userId, "whiteboard.restored", {
    viewId,
    versionId,
    message: "Whiteboard restored to previous version",
  });

  logger.info({ viewId, versionId }, "Whiteboard restored");
}

// ============================================================================
// Whiteboard Auto-Save (cron)
// ============================================================================

export async function handleWhiteboardAutoSave(): Promise<void> {
  logger.info("Running auto-save for active whiteboards (placeholder)");
  // Placeholder — implement session tracking for active whiteboards
}
