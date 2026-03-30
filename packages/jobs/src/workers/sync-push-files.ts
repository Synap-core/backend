/**
 * Sync Push Files Worker
 *
 * Cron job (every 10 minutes) that pushes document content and file blobs
 * to registered push peers.
 *
 * Event replication (sync-push) handles entity/view metadata but NOT the actual
 * document content stored in S3/MinIO. This worker closes that gap by:
 *
 * 1. For each enabled push peer:
 *    a. Read `supplementaryCursors.files` from the peer's sync_state row
 *    b. Query documents WHERE `updatedAt > fileCursor` that have a storageKey
 *    c. For each document: download content from local storage, POST to peer
 *    d. Advance the files cursor on success
 *
 * 2. Also syncs document_versions created since the last cursor, sending the
 *    version content (text snapshots) so the peer has full version history.
 *
 * File content is base64-encoded in JSON for Phase 4 simplicity.
 * A future phase can switch to multipart/streaming for large files.
 */

import {
  db,
  syncPeers,
  syncState,
  eq,
  and,
  or,
  gt,
  drizzleSql,
} from "@synap/database";
import { documents, documentVersions } from "@synap/database/schema";
import { storage } from "@synap/storage";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "sync-push-files" });

/** Maximum consecutive errors before we stop retrying (requires manual reset) */
const MAX_ERROR_COUNT = 10;

/** Maximum documents per cycle per peer */
const BATCH_SIZE = 50;

/** HTTP timeout for file sync requests (ms) — longer than event sync due to file size */
const SYNC_TIMEOUT_MS = 120_000;

/** Maximum file size to sync in this phase (10 MB). Larger files are skipped with a warning. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Source pod identifier (from env or fallback) */
const SOURCE_POD_ID =
  process.env.POD_ID || process.env.SYNAP_POD_ID || "unknown";

interface FileReceiveResponse {
  received: boolean;
  backpressure?: boolean;
}

// ============================================================================
// Cursor helpers — files cursor lives in supplementaryCursors.files
// ============================================================================

function getFileCursor(state: {
  supplementaryCursors: Record<string, string> | null;
}): Date {
  const raw = state.supplementaryCursors?.files;
  if (!raw) return new Date(0);
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function buildUpdatedSupplementaryCursors(
  existing: Record<string, string> | null,
  newFileCursor: Date
): Record<string, string> {
  return {
    ...(existing ?? {}),
    files: newFileCursor.toISOString(),
  };
}

// ============================================================================
// Push files to a single peer
// ============================================================================

async function pushFilesToPeer(peer: {
  id: string;
  peerPodUrl: string;
  authToken: string | null;
}): Promise<void> {
  // Ensure sync_state row exists for this peer
  let state = await db.query.syncState.findFirst({
    where: eq(syncState.syncPeerId, peer.id),
  });

  if (!state) {
    const [inserted] = await db
      .insert(syncState)
      .values({ syncPeerId: peer.id })
      .returning();
    state = inserted;
  }

  // If error count exceeded, don't retry
  if (state.errorCount >= MAX_ERROR_COUNT) {
    logger.warn(
      { peerId: peer.id, errorCount: state.errorCount },
      "Sync peer exceeded max errors — skipping file sync until manual reset"
    );
    return;
  }

  const fileCursor = getFileCursor(state);

  // -------------------------------------------------------------------
  // Phase A: Sync document storage blobs (files with a storageKey)
  // -------------------------------------------------------------------

  const docsToSync = await db
    .select({
      id: documents.id,
      storageKey: documents.storageKey,
      storageUrl: documents.storageUrl,
      mimeType: documents.mimeType,
      size: documents.size,
      title: documents.title,
      type: documents.type,
      currentVersion: documents.currentVersion,
      workspaceId: documents.workspaceId,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(
      and(
        gt(documents.updatedAt, fileCursor),
        drizzleSql`${documents.storageKey} IS NOT NULL`,
        drizzleSql`${documents.deletedAt} IS NULL`
      )
    )
    .orderBy(documents.updatedAt)
    .limit(BATCH_SIZE);

  if (docsToSync.length === 0) {
    // Nothing new — still check for document versions below
  }

  let filesSent = 0;
  let latestCursor = fileCursor;

  const baseUrl = peer.peerPodUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Source-Pod-Id": SOURCE_POD_ID,
  };
  if (peer.authToken) {
    headers["Authorization"] = `Bearer ${peer.authToken}`;
  }

  for (const doc of docsToSync) {
    try {
      // Skip documents that are too large for Phase 4
      if (doc.size > MAX_FILE_SIZE) {
        logger.warn(
          { documentId: doc.id, size: doc.size, maxSize: MAX_FILE_SIZE },
          "Skipping large file — exceeds Phase 4 size limit"
        );
        // Still advance cursor past this doc so we don't re-attempt every cycle
        if (doc.updatedAt > latestCursor) {
          latestCursor = doc.updatedAt;
        }
        continue;
      }

      // Download content from local storage
      let contentBase64: string;
      try {
        const buffer = await storage.downloadBuffer(doc.storageKey!);
        contentBase64 = buffer.toString("base64");
      } catch (downloadErr) {
        logger.warn(
          { documentId: doc.id, storageKey: doc.storageKey, err: downloadErr },
          "Failed to download file from local storage — skipping"
        );
        if (doc.updatedAt > latestCursor) {
          latestCursor = doc.updatedAt;
        }
        continue;
      }

      // POST to peer
      const payload = {
        documentId: doc.id,
        storageKey: doc.storageKey,
        mimeType: doc.mimeType ?? "application/octet-stream",
        size: doc.size,
        title: doc.title,
        type: doc.type,
        currentVersion: doc.currentVersion,
        workspaceId: doc.workspaceId,
        contentBase64,
      };

      const response = await fetch(`${baseUrl}/api/sync/receive-file`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        throw new Error(
          `Peer responded ${response.status}: ${errorText.slice(0, 200)}`
        );
      }

      const result = (await response.json()) as FileReceiveResponse;

      if (result.backpressure) {
        logger.info(
          { peerId: peer.id },
          "Peer signalled backpressure for file sync — stopping this cycle"
        );
        break;
      }

      filesSent++;
      if (doc.updatedAt > latestCursor) {
        latestCursor = doc.updatedAt;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { peerId: peer.id, documentId: doc.id, error: errorMessage },
        "Failed to push file to sync peer"
      );

      // Increment error count and bail out of this peer for this cycle
      const newErrorCount = state.errorCount + 1;
      await db
        .update(syncState)
        .set({
          status: newErrorCount >= MAX_ERROR_COUNT ? "error" : "idle",
          errorCount: newErrorCount,
          lastError: `File sync: ${errorMessage.slice(0, 500)}`,
          lastSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(syncState.id, state.id));
      return;
    }
  }

  // -------------------------------------------------------------------
  // Phase B: Sync document versions (text snapshots for version history)
  // -------------------------------------------------------------------

  const versionsToSync = await db
    .select({
      id: documentVersions.id,
      documentId: documentVersions.documentId,
      version: documentVersions.version,
      content: documentVersions.content,
      author: documentVersions.author,
      authorId: documentVersions.authorId,
      message: documentVersions.message,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .where(gt(documentVersions.createdAt, fileCursor))
    .orderBy(documentVersions.createdAt)
    .limit(BATCH_SIZE);

  for (const ver of versionsToSync) {
    try {
      const payload = {
        versionId: ver.id,
        documentId: ver.documentId,
        version: ver.version,
        content: ver.content,
        author: ver.author,
        authorId: ver.authorId,
        message: ver.message,
        createdAt:
          ver.createdAt instanceof Date
            ? ver.createdAt.toISOString()
            : String(ver.createdAt),
      };

      const response = await fetch(`${baseUrl}/api/sync/receive-file-version`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        throw new Error(
          `Peer responded ${response.status}: ${errorText.slice(0, 200)}`
        );
      }

      const result = (await response.json()) as FileReceiveResponse;
      if (result.backpressure) {
        logger.info(
          { peerId: peer.id },
          "Peer signalled backpressure for version sync — stopping this cycle"
        );
        break;
      }

      filesSent++;
      if (ver.createdAt > latestCursor) {
        latestCursor = ver.createdAt;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { peerId: peer.id, versionId: ver.id, error: errorMessage },
        "Failed to push document version to sync peer"
      );
      // Don't increment error count for version failures — file sync is best-effort
      break;
    }
  }

  // -------------------------------------------------------------------
  // Update cursor
  // -------------------------------------------------------------------

  if (latestCursor > fileCursor) {
    await db
      .update(syncState)
      .set({
        supplementaryCursors: buildUpdatedSupplementaryCursors(
          state.supplementaryCursors,
          latestCursor
        ),
        lastSyncAt: new Date(),
        status: "idle",
        errorCount: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(syncState.id, state.id));

    logger.info(
      {
        peerId: peer.id,
        filesSent,
        cursor: latestCursor.toISOString(),
      },
      "File sync push cycle completed"
    );
  } else {
    // Nothing new — just mark as idle
    await db
      .update(syncState)
      .set({ status: "idle", lastSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(syncState.id, state.id));
  }
}

// ============================================================================
// Main handler — called by pg-boss cron every 10 minutes
// ============================================================================

export async function handleSyncPushFiles(): Promise<void> {
  try {
    // Fetch all enabled push/bidirectional peers
    const peers = await db.query.syncPeers.findMany({
      where: and(
        or(
          eq(syncPeers.direction, "push"),
          eq(syncPeers.direction, "bidirectional")
        ),
        eq(syncPeers.enabled, true)
      ),
    });

    if (peers.length === 0) {
      return; // No push peers configured — nothing to do
    }

    logger.debug({ peerCount: peers.length }, "Starting file sync push cycle");

    // Process each peer sequentially (avoid overwhelming outbound bandwidth)
    for (const peer of peers) {
      try {
        await pushFilesToPeer(peer);
      } catch (err) {
        // Catch-all so one peer failing doesn't block others
        logger.error(
          { peerId: peer.id, err },
          "Unexpected error pushing files to sync peer"
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("relation") && msg.includes("does not exist")) {
      logger.debug("Sync push files skipped — sync tables not yet migrated");
    } else {
      logger.error({ err }, "Sync push files worker top-level error");
    }
  }
}

export const SYNC_PUSH_FILES_QUEUE = "sync-push-files";
