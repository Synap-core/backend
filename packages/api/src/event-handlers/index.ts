/**
 * Event Handlers Index
 *
 * Registers all event handlers with the event system
 *
 * Note: Currently a manual setup. In the future, this could be
 * automated with an event bus/dispatcher system.
 */

import { db, events, desc } from "@synap/database";
import { handleInboxItemReceived } from "./inbox-storage.js";
import { handleInboxItemIntelligence } from "./inbox-intelligence.js";
import { handleInboxItemAnalyzed } from "./inbox-analysis.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "event-handlers" });

/**
 * Process all unprocessed events
 *
 * This is a simple polling-based event processor.
 * In production, you might want to use:
 * - Database triggers
 * - Message queue (Redis, RabbitMQ)
 * - Real-time subscriptions (pg_notify)
 */
export async function processEvents() {
  logger.debug("Processing events");

  try {
    // Get latest events (last 100)
    const latestEvents = await db
      .select()
      .from(events)
      .orderBy(desc(events.timestamp))
      .limit(100);

    for (const event of latestEvents) {
      try {
        // Route event to appropriate handler based on type
        switch (event.type) {
          case "inbox.item.received":
            logger.debug({ eventId: event.id }, "Handling inbox.item.received");
            // Storage handler - writes to DB
            await handleInboxItemReceived({
              type: "inbox.item.received",
              subjectId: event.subjectId,
              subjectType: event.subjectType as "inbox_item", // ✅ Type cast
              data: event.data as any,
              id: event.id,
              userId: event.userId,
              timestamp: event.timestamp,
            });
            // Intelligence handler - calls service
            await handleInboxItemIntelligence({
              type: "inbox.item.received",
              subjectId: event.subjectId,
              subjectType: event.subjectType as "inbox_item", // ✅ Type cast
              data: event.data as any,
              id: event.id,
              userId: event.userId,
              timestamp: event.timestamp,
            });
            break;

          case "inbox.item.analyzed":
            logger.debug({ eventId: event.id }, "Handling inbox.item.analyzed");
            await handleInboxItemAnalyzed({
              type: "inbox.item.analyzed",
              subjectId: event.subjectId,
              subjectType: event.subjectType as "inbox_item", // ✅ Type cast
              data: event.data as any,
              id: event.id,
              userId: event.userId,
              timestamp: event.timestamp,
            });
            break;

          // Add more event handlers here
          default:
            // Unknown event type - skip
            break;
        }
      } catch (error) {
        logger.error(
          {
            err: error,
            eventId: event.id,
            eventType: event.type,
          },
          "Error processing event",
        );
        // Continue processing other events
      }
    }

    logger.debug("Events processed");
  } catch (error) {
    logger.error({ err: error }, "Failed to process events");
    throw error;
  }
}

/**
 * Start event processing loop
 * Polls for new events every 5 seconds
 *
 * Note: This is a simple implementation. In production, use a proper
 * message queue or event streaming system.
 */
export function startEventProcessor() {
  logger.info("Starting event processor");

  // Process immediately
  processEvents().catch((err) =>
    logger.error({ err }, "Event processing failed"),
  );

  // Then poll every 5 seconds
  setInterval(() => {
    processEvents().catch((err) =>
      logger.error({ err }, "Event processing failed"),
    );
  }, 5000);

  logger.info("Event processor started (polling every 5s)");
}
