/**
 * Event Handlers Index
 *
 * Registers all event handlers with the event system
 *
 * Note: Currently a manual setup. In the future, this could be
 * automated with an event bus/dispatcher system.
 */

import { db, events, asc, gt } from "@synap/database";
import { handleInboxItemReceived } from "./inbox-storage.js";
import { handleInboxItemIntelligence } from "./inbox-intelligence.js";
import { handleInboxItemAnalyzed } from "./inbox-analysis.js";
import { createLogger } from "@synap-core/core";
import { extractEventInfo, type UnifiedEventData } from "@synap/jobs";

const logger = createLogger({ module: "event-handlers" });

/**
 * Watermark: only forward events newer than this timestamp to Inngest.
 * Initialized to epoch so existing unprocessed events are forwarded once on startup.
 * Updated after each poll to the newest event's timestamp.
 */
let lastForwardedTimestamp: Date = new Date(0);

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
    // Only fetch events newer than the last forwarded timestamp (watermark).
    // This prevents re-sending the same events to Inngest on every poll.
    const latestEvents = await db
      .select()
      .from(events)
      .where(gt(events.timestamp, lastForwardedTimestamp))
      .orderBy(asc(events.timestamp))
      .limit(100);

    for (const event of latestEvents) {
      try {
        // Parse event type using unified event system
        let eventInfo: {
          subjectType: string;
          action: string;
          phase: string;
        } | null = null;
        try {
          eventInfo = extractEventInfo(event.type);
        } catch {
          // Legacy event format - handle separately
        }

        if (event.type.startsWith("entities")) {
          logger.debug(
            { eventId: event.id, type: event.type },
            "Found entities event in processor"
          );
        }

        // Route event to appropriate handler based on type
        // Legacy inbox events (not using unified format)
        // These use specific event types from @synap/events
        if (event.type === "inbox.item.received") {
          logger.debug({ eventId: event.id }, "Handling inbox.item.received");
          // Storage handler - writes to DB
          // Type assertion is safe here because we know the event type matches
          await handleInboxItemReceived({
            type: "inbox.item.received",
            subjectId: event.subjectId,
            subjectType: event.subjectType as "inbox_item",
            data: event.data as Parameters<
              typeof handleInboxItemReceived
            >[0]["data"],
            id: event.id,
            userId: event.userId,
            timestamp: event.timestamp,
          });
          // Intelligence handler - calls service
          await handleInboxItemIntelligence({
            type: "inbox.item.received",
            subjectId: event.subjectId,
            subjectType: event.subjectType as "inbox_item",
            data: event.data as Parameters<
              typeof handleInboxItemIntelligence
            >[0]["data"],
            id: event.id,
            userId: event.userId,
            timestamp: event.timestamp,
          });
          continue;
        }

        if (event.type === "inbox.item.analyzed") {
          logger.debug({ eventId: event.id }, "Handling inbox.item.analyzed");
          await handleInboxItemAnalyzed({
            type: "inbox.item.analyzed",
            subjectId: event.subjectId,
            subjectType: event.subjectType as "inbox_item",
            data: event.data as Parameters<
              typeof handleInboxItemAnalyzed
            >[0]["data"],
            id: event.id,
            userId: event.userId,
            timestamp: event.timestamp,
          });
          continue;
        }

        // Unified event format: {subjectType}.{action}.{phase}
        if (eventInfo) {
          const { phase } = eventInfo;

          // Forward requested/validated/completed events to Inngest for background processing
          // This is the bridge between the Event Store and Inngest
          // "completed" is needed for workspaces.create.completed (default whiteboard, views, commands)
          if (
            phase === "requested" ||
            phase === "validated" ||
            phase === "completed"
          ) {
            logger.info(
              { eventId: event.id, eventType: event.type, phase },
              "Forwarding event to Inngest"
            );
            const { inngest } = await import("@synap/jobs");

            await inngest.send({
              name: event.type,
              data: event.data as UnifiedEventData,
              user: { id: event.userId },
            });
          }
        } else {
          // Legacy event format - try to forward if it looks like a unified event
          if (
            event.type.includes(".requested") ||
            event.type.includes(".validated") ||
            event.type.includes(".completed")
          ) {
            logger.info(
              { eventId: event.id, eventType: event.type },
              "Forwarding legacy event to Inngest"
            );
            const { inngest } = await import("@synap/jobs");

            await inngest.send({
              name: event.type,
              data: event.data as UnifiedEventData,
              user: { id: event.userId },
            });
          }
        }
      } catch (error) {
        logger.error(
          {
            err: error,
            eventId: event.id,
            eventType: event.type,
          },
          "Error processing event"
        );
        // Continue processing other events
      }
    }

    // Advance watermark to the newest event processed so next poll skips them
    if (latestEvents.length > 0) {
      const newest = latestEvents[latestEvents.length - 1];
      if (newest.timestamp > lastForwardedTimestamp) {
        lastForwardedTimestamp = newest.timestamp;
        logger.debug(
          { watermark: lastForwardedTimestamp, count: latestEvents.length },
          "Advanced event watermark"
        );
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
 * Polls for new events with a delay between executions
 */
export async function startEventProcessor() {
  logger.info("Starting event processor...");

  const poll = async () => {
    const start = Date.now();
    try {
      await processEvents();
      const duration = Date.now() - start;
      if (duration > 1000) {
        logger.warn({ duration }, "Event processing took significant time");
      }
    } catch (err) {
      logger.error({ err }, "Event processing failed");
    }

    // Wait 5 seconds AFTER processing finishes before starting next poll
    setTimeout(poll, 5000);
  };

  // Start the first poll
  poll();
  logger.info("Event processor started (adaptive polling)");
}
