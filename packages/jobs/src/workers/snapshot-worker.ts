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
  claimDocumentRevision,
  INHERIT_LAST_AUTHOR,
  emitDocumentContentReplaced,
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
import { emitSideEffects } from "@synap/events";
import { broadcastSuccess } from "../utils/realtime-broadcast.js";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "snapshot-worker" });

// ============================================================================
// Document Snapshot
// ============================================================================
//
// Every document write below goes through `claimDocumentRevision`, the ONE
// content-write door (compare-and-set, author-switch checkpoints, the storage
// upload). None of these handlers touches `documents.storage_key` itself.

export async function handleDocumentSnapshot(
  job: PgBoss.Job<{
    documentId: string;
    message?: string;
    userId: string;
  }>
): Promise<void> {
  const { documentId, message, userId } = job.data;

  const claimed = await db.transaction((tx) =>
    claimDocumentRevision(
      tx,
      documentId,
      undefined,
      { authorKind: "user", authorId: userId },
      { checkpoint: { message: message || "Saved version" } }
    )
  );
  if (!claimed.checkpointVersionId) {
    throw new Error(
      `Document ${documentId}: a checkpoint claim cut no row (door contract broken)`
    );
  }

  await broadcastSuccess(userId, "document.snapshot.saved", {
    documentId,
    versionId: claimed.checkpointVersionId,
    version: claimed.currentVersion,
    message: message || "Saved version",
  });

  logger.info(
    { documentId, version: claimed.currentVersion },
    "Document snapshot saved"
  );
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

  const restoredBuffer = await readDocumentVersionBuffer(version);
  // A row the realtime server once wrote holds Yjs binary state, not text
  // (`documents.restoreVersion` refuses it up front; this is the worker's own
  // floor, since the payload is trusted).
  if (restoredBuffer.subarray(0, 4).toString("utf-8") === "yjs:") {
    throw new Error(
      `Version ${versionId} holds realtime editor state, not document text — refusing to restore it`
    );
  }

  // Restore is a WRITE by the restoring person, checkpointed, so the rail says
  // who brought the old text back (and the text it replaced is kept).
  const claimed = await db.transaction((tx) =>
    claimDocumentRevision(
      tx,
      documentId,
      undefined,
      { authorKind: "user", authorId: userId },
      {
        content: restoredBuffer,
        ...(version.mimeType ? { mimeType: version.mimeType } : {}),
        checkpoint: { message: `Restored from version ${version.version}` },
      }
    )
  );

  const emitted = await emitDocumentContentReplaced({
    documentId,
    revision: claimed.revision,
    workspaceId: claimed.workspaceId,
    ownerUserId: claimed.ownerUserId,
  });
  if (!emitted.ok) {
    logger.warn(
      { documentId, error: emitted.error },
      "document:content-replaced emit failed after a restore — open editors were not told"
    );
  }
  // Re-index the restored text (search reads the stored body).
  void emitSideEffects({
    subjectType: "document",
    action: "update",
    subjectId: documentId,
    userId,
    workspaceId: claimed.workspaceId,
    data: { id: documentId },
  });

  await broadcastSuccess(userId, "document.restored", {
    documentId,
    restoredFromVersion: version.version,
    currentVersion: claimed.currentVersion,
  });

  logger.info(
    { documentId, restoredFromVersion: version.version },
    "Document restored"
  );
}

// ============================================================================
// Document Auto-Save (cron)
// ============================================================================

/**
 * Checkpoint every document with an active editing session — but ONLY when its
 * content moved since the last checkpoint. It used to cut a row (and bump
 * `current_version`) every 30 minutes for every open document, unchanged or
 * not, which flooded the rail and made pending AI proposals CONFLICT.
 *
 * The row is attributed to the last checkpoint's author (INHERIT_LAST_AUTHOR).
 */
export async function handleDocumentAutoSave(): Promise<void> {
  const activeSessions = await db.query.documentSessions.findMany({
    where: eq(documentSessions.isActive, true),
    limit: 100,
  });

  if (activeSessions.length === 0) return;

  const documentIds = [...new Set(activeSessions.map((s) => s.documentId))];
  const results = await Promise.allSettled(
    documentIds.map((documentId) =>
      db.transaction((tx) =>
        claimDocumentRevision(tx, documentId, undefined, INHERIT_LAST_AUTHOR, {
          checkpoint: { message: "Auto-save checkpoint" },
          skipIfUnchanged: true,
        })
      )
    )
  );

  const failed = results.filter((r) => r.status === "rejected");
  for (const r of failed) {
    logger.warn(
      { err: (r as PromiseRejectedResult).reason },
      "Document auto-save checkpoint failed"
    );
  }
  const saved = results.filter(
    (r) => r.status === "fulfilled" && !r.value.skipped
  ).length;
  logger.info(
    {
      documents: documentIds.length,
      checkpointed: saved,
      unchanged: documentIds.length - saved - failed.length,
      failed: failed.length,
    },
    "Document auto-save complete"
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
      ...(process.env.BRIDGE_SECRET
        ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
        : {}),
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
      ...(process.env.BRIDGE_SECRET
        ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
        : {}),
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
