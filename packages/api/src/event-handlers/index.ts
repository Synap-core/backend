/**
 * Event Handlers Index
 *
 * Registers all event handlers with the event system
 *
 * Note: Currently a manual setup. In the future, this could be
 * automated with an event bus/dispatcher system.
 */

import { db, sql as pgSql, events, asc, gt } from "@synap/database";
import { handleInboxItemReceived } from "./inbox-storage.js";
import { handleInboxItemIntelligence } from "./inbox-intelligence.js";
import { handleInboxItemAnalyzed } from "./inbox-analysis.js";
import { createLogger } from "@synap-core/core";
import { extractEventInfo, type UnifiedEventData } from "@synap/jobs";

const logger = createLogger({ module: "event-handlers" });

const WATERMARK_KEY = "event_processor_watermark";

/**
 * Watermark: only forward events newer than this timestamp to Inngest.
 * Persisted in system_settings so restarts don't replay old events.
 * Initialized to epoch until loadWatermark() runs on startup.
 */
let lastForwardedTimestamp: Date = new Date(0);

/**
 * Load the persisted watermark from the database.
 * On first run (no persisted value), initializes to the current latest event
 * so we don't replay the entire event history on startup.
 */
async function loadWatermark(): Promise<void> {
  try {
    const rows = await pgSql<{ value: string }[]>`
      SELECT value FROM system_settings WHERE key = ${WATERMARK_KEY}
    `;
    if (rows.length > 0) {
      lastForwardedTimestamp = new Date(rows[0].value);
      logger.info({ watermark: lastForwardedTimestamp }, "Loaded event watermark from DB");
    } else {
      // First run — skip historical events by starting at the latest known event.
      // Events that were already processed before this deployment are already
      // reflected in DB tables; re-replaying them would cause duplicates.
      const latest = await pgSql<{ max_ts: string | null }[]>`
        SELECT MAX(timestamp)::text AS max_ts FROM events
      `;
      const startAt = latest[0]?.max_ts ? new Date(latest[0].max_ts) : new Date();
      lastForwardedTimestamp = startAt;
      await saveWatermark(startAt);
      logger.info({ watermark: startAt }, "First run — initialized watermark to latest event");
    }
  } catch (err) {
    logger.warn({ err }, "Could not load watermark from DB — starting from epoch");
  }
}

/**
 * Persist the current watermark to the database.
 */
async function saveWatermark(ts: Date): Promise<void> {
  try {
    await pgSql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (${WATERMARK_KEY}, ${ts.toISOString()}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at
    `;
  } catch (err) {
    logger.warn({ err }, "Could not persist watermark to DB");
  }
}

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

          // Forward requested and completed events to Inngest for background processing.
          // This is the bridge between the Event Store and Inngest.
          //
          // "requested" → emitted by API routers; only in DB, so must be forwarded here.
          // "completed" → emitted by BaseRepository (DB-only); must be forwarded here.
          //               Needed e.g. for workspaces.create.completed (default whiteboard setup).
          //
          // "validated" is intentionally EXCLUDED: globalValidator writes it to DB AND
          // sends it directly to Inngest (inngest.send()). Forwarding it here would cause
          // the executor to fire twice, creating duplicate entities/documents.
          if (phase === "requested" || phase === "completed") {
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
          // Legacy event format - forward requested/completed only (not validated, same reason above)
          if (
            event.type.includes(".requested") ||
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
        // Persist watermark so restarts don't replay old events
        await saveWatermark(lastForwardedTimestamp);
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

  // Load persisted watermark before first poll so we don't replay old events
  await loadWatermark();

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
