/**
 * Whiteboard Snapshot Workers
 *
 * Handles async processing of whiteboard version snapshots and restoration.
 * Fetches Yjs state from realtime server and persists to database.
 */

import { inngest } from "../client.js";
import { db, eq } from "@synap/database";
import { documents, documentVersions, views } from "@synap/database/schema";
import { broadcastSuccess } from "../utils/realtime-broadcast.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "whiteboard-snapshots" });

/**
 * Process whiteboard snapshot requests
 *
 * Steps:
 * 1. Fetch current Yjs state from realtime server
 * 2. Save as new version in documentVersions
 * 3. Update document currentVersion
 * 4. Broadcast completion to user
 */
export const whiteboardSnapshotWorker = inngest.createFunction(
  {
    id: "whiteboard-snapshots",
    name: "Process Whiteboard Snapshots",
    retries: 3,
  },
  { event: "whiteboards.snapshot.requested" },
  async ({ event, step }) => {
    const { viewId, documentId, yjsRoomId, message, userId } = event.data;

    logger.info({ viewId, yjsRoomId }, "Processing whiteboard snapshot");

    // Step 1: Fetch current Yjs state from realtime server
    const yjsState = await step.run("fetch-yjs-state", async () => {
      const REALTIME_URL = process.env.REALTIME_URL || "http://localhost:4001";

      try {
        const response = await fetch(`${REALTIME_URL}/yjs/${yjsRoomId}/state`, {
          headers: {
            "X-Internal-Request": "true",
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          throw new Error(`Realtime server error: ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        const base64State = Buffer.from(buffer).toString("base64");

        logger.info(
          { yjsRoomId, size: buffer.byteLength },
          "Fetched Yjs state",
        );

        return base64State;
      } catch (error) {
        logger.error({ error, yjsRoomId }, "Failed to fetch Yjs state");
        throw error;
      }
    });

    // Step 2: Get current version number
    const document = await step.run("get-document", async () => {
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });

      return doc;
    });

    if (!document) {
      throw new Error(`Document ${documentId} not found`);
    }

    const newVersion = (document.currentVersion || 0) + 1;

    // Step 3: Save version snapshot
    const version = await step.run("save-version", async () => {
      const [v] = await db
        .insert(documentVersions)
        .values({
          documentId,
          version: newVersion,
          content: yjsState,
          message: message || "Snapshot",
          author: "user",
          authorId: userId,
        })
        .returning();

      logger.info({ versionId: v.id, version: newVersion }, "Saved version");

      return v;
    });

    // Step 4: Update document currentVersion
    await step.run("update-document", async () => {
      await db
        .update(documents)
        .set({
          currentVersion: newVersion,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));

      logger.info({ documentId, newVersion }, "Updated document version");
    });

    // Step 5: Broadcast completion to user
    await step.run("broadcast-success", async () => {
      await broadcastSuccess(userId, "whiteboard.snapshot.saved", {
        viewId,
        versionId: version.id,
        version: newVersion,
        message,
      });
    });

    return {
      success: true,
      versionId: version.id,
      version: newVersion,
    };
  },
);

/**
 * Restore whiteboard to previous version
 *
 * Steps:
 * 1. Get view and version details
 * 2. Push restored state to Yjs room (all connected clients update)
 * 3. Broadcast completion
 */
export const whiteboardRestoreWorker = inngest.createFunction(
  {
    id: "whiteboard-restore",
    name: "Restore Whiteboard Version",
    retries: 2,
  },
  { event: "whiteboards.restore.requested" },
  async ({ event, step }) => {
    const { viewId, versionId, yjsRoomId, content, userId } = event.data;

    logger.info(
      { viewId, versionId, yjsRoomId },
      "Restoring whiteboard version",
    );

    // Step 1: Validate view exists
    await step.run("validate-view", async () => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, viewId),
      });

      if (!view) {
        throw new Error(`View ${viewId} not found`);
      }

      return view;
    });

    // Step 2: Push restored state to Yjs room
    await step.run("push-to-yjs", async () => {
      const REALTIME_URL = process.env.REALTIME_URL || "http://localhost:4001";

      try {
        const response = await fetch(
          `${REALTIME_URL}/yjs/${yjsRoomId}/restore`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Request": "true",
            },
            body: JSON.stringify({ state: content }),
          },
        );

        if (!response.ok) {
          throw new Error(`Realtime server error: ${response.status}`);
        }

        logger.info({ yjsRoomId }, "Pushed restored state to Yjs");
      } catch (error) {
        logger.error({ error, yjsRoomId }, "Failed to restore Yjs state");
        throw error;
      }
    });

    // Step 3: Broadcast to all users (whiteboard restored)
    await step.run("broadcast-success", async () => {
      await broadcastSuccess(userId, "whiteboard.restored", {
        viewId,
        versionId,
        message: "Whiteboard restored to previous version",
      });
    });

    return { success: true };
  },
);

/**
 * Auto-save worker (triggered by timer)
 * Periodically saves snapshots of active whiteboards
 */
export const whiteboardAutoSaveWorker = inngest.createFunction(
  {
    id: "whiteboard-auto-save",
    name: "Auto-save Active Whiteboards",
  },
  { cron: "*/30 * * * *" }, // Every 30 minutes
  async () => {
    logger.info("Running auto-save for active whiteboards");

    // Get all active whiteboard sessions (simplified - would check sessions table)
    // For now, this is a placeholder for future enhancement

    return { message: "Auto-save placeholder - implement session tracking" };
  },
);
