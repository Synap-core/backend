/**
 * Document Persistence Workers
 *
 * Handles periodic background persistence of "Working State" (Yjs/Content).
 * This ensures that if the server crashes, we don't lose the active "Text Buffer"
 * or "Yjs Room State" that hasn't been saved as a version yet.
 */

import { inngest } from "../client.js";
import { db, eq } from "@synap/database";
import { documents, documentSessions } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "document-persistence" });

/**
 * Persist Working State Worker
 * Triggered by: Cron (every 5 mins) or `documents.persistence.requested`
 */
export const documentPersistenceWorker = inngest.createFunction(
  {
    id: "document-persistence",
    name: "Persist Document Working State",
    retries: 2,
  },
  { cron: "*/5 * * * *" }, // Run every 5 minutes
  async ({ step }) => {
    logger.info("Running persistence check for active documents");

    // 1. Get active sessions
    const activeSessions = await step.run("get-active-sessions", async () => {
      return db.query.documentSessions.findMany({
        where: eq(documentSessions.isActive, true),
        limit: 50, // Batch limit
      });
    });

    if (activeSessions.length === 0) {
      return { message: "No active sessions" };
    }

    // 2. Persist state for each active doc
    const results = await Promise.all(
      activeSessions.map(async (session) => {
        try {
          const REALTIME_URL =
            process.env.REALTIME_URL || "http://localhost:4001";

          // Fetch current buffer/state from Yjs room
          // The room ID is typically the documentId or chatThreadId depending on architecture.
          // In this system, collaborative editing usually happens in a room named after the documentId.
          const yjsRoomId = session.documentId;

          const response = await fetch(
            `${REALTIME_URL}/yjs/${yjsRoomId}/state`,
            {
              headers: {
                "X-Internal-Request": "true",
                "Content-Type": "application/json",
              },
            }
          );

          if (!response.ok) {
            // If 404, maybe room isn't active in memory (cleared), so nothing to persist.
            if (response.status === 404)
              return { id: session.documentId, status: "skipped-no-room" };
            throw new Error(`Realtime server error: ${response.status}`);
          }

          const buffer = await response.arrayBuffer();
          // Convert binary Yjs update to base64 string for storage
          const base64State = Buffer.from(buffer).toString("base64");

          // Update document working state
          await db
            .update(documents)
            .set({
              workingState: base64State,
              workingStateUpdatedAt: new Date(),
            })
            .where(eq(documents.id, session.documentId));

          return { id: session.documentId, status: "persisted" };
        } catch (e) {
          logger.error(
            { error: e, documentId: session.documentId },
            "Failed to persist document state"
          );
          return {
            id: session.documentId,
            error: e instanceof Error ? e.message : "Unknown error",
          };
        }
      })
    );

    return { results };
  }
);
