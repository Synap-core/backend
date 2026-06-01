/**
 * Setup Event Broadcasting + Materialization Hooks
 *
 * This module registers hooks with the EventRepository:
 * 1. SSE broadcast hook — streams events to connected clients (admin)
 * 2. Domain event bridge — forwards .completed events to Realtime (Socket.IO) for entity, view, relation, document, workspace, workspace member
 * 3. Materialization hook — enqueues .validated events for DB writes via pg-boss
 *
 * Call setupEventBroadcasting() at application startup.
 */

import { eventRepository, type EventHook } from "@synap/database";
import { eventStreamManager } from "./event-stream-manager.js";
import { getBoss } from "@synap/jobs";
import { createLogger } from "@synap-core/core";
import { emitDomainEventToRealtime } from "./utils/domain-event-bridge.js";
import { syncRealtimeHook } from "./utils/sync-realtime-hook.js";

const logger = createLogger({ module: "event-broadcasting" });

let isSetup = false;

/**
 * Setup event broadcasting and materialization hooks
 *
 * This function should be called once at application startup.
 * It registers hooks with the EventRepository.
 */
export function setupEventBroadcasting(): void {
  if (isSetup) {
    logger.warn("Event broadcasting already setup, skipping");
    return;
  }

  // Hook 1: SSE broadcast — stream all events to connected clients
  const broadcastHook: EventHook = (event) => {
    eventStreamManager.broadcast(event);
  };

  // Hook 2: Domain event → Socket.IO bridge
  const domainBridgeHook: EventHook = (event) => {
    emitDomainEventToRealtime(event);
  };

  // Hook 3: Materialization — enqueue .validated events for async DB writes
  // This is the bridge between the event pipeline and the materializer worker.
  // When a proposal is approved, the approval flow emits a .validated event
  // which this hook picks up and sends to the materializer via pg-boss.
  const materializationHook: EventHook = async (event) => {
    if (event.eventType.endsWith(".validated")) {
      try {
        // Parse event type: "entity.create.validated" → subjectType=entity, action=create
        const parts = event.eventType.split(".");
        if (parts.length < 3) return;

        const [subjectType, action] = parts;

        await getBoss().send("materialize", {
          eventId: event.id,
          eventType: event.eventType,
          subjectType,
          action,
          subjectId: event.subjectId,
          userId: event.userId,
          workspaceId: event.data?.workspaceId,
          correlationId: event.correlationId,
          data: event.data,
        });

        logger.debug(
          { eventType: event.eventType, subjectId: event.subjectId },
          "Enqueued materialization job"
        );
      } catch (error) {
        logger.warn(
          { err: error, eventType: event.eventType },
          "Failed to enqueue materialization (non-fatal)"
        );
      }
    }
  };

  // Hook 4: Real-time sync push — immediately forwards .completed events to
  // registered sync peers over HTTPS. Fire-and-forget with batching (500ms
  // debounce). On success, advances outbound sync_state cursors; the pg-boss
  // sync-push worker (scheduled every minute) catches missed batches.
  // See: utils/sync-realtime-hook.ts

  // Hook 5: Proactive intelligence (Feature C, Phase 2). On entity create/update
  // .validated events ONLY, enqueue a cheap `proactive.evaluate` job. The worker
  // (packages/jobs/.../proactive-intelligence.ts) loads the entity, applies the
  // loop guard, checks workspace settings, maps to a trigger, and debounces a
  // scan. We deliberately do NOT load entities or settings here — the hook stays
  // minimal + fire-and-forget like the materialization hook.
  const proactiveIntelligenceHook: EventHook = async (event) => {
    if (
      event.eventType === "entity.create.validated" ||
      event.eventType === "entity.update.validated"
    ) {
      try {
        // "entity.create.validated" → action = "create"
        const action = event.eventType.split(".")[1];
        await getBoss().send("proactive.evaluate", {
          entityId: event.subjectId,
          eventType: event.eventType,
          action,
          userId: event.userId,
          correlationId: event.correlationId,
        });
      } catch (error) {
        logger.warn(
          { err: error, eventType: event.eventType },
          "Failed to enqueue proactive.evaluate (non-fatal)"
        );
      }
    }
  };

  // Register all hooks
  eventRepository.addEventHook(broadcastHook);
  eventRepository.addEventHook(domainBridgeHook);
  eventRepository.addEventHook(materializationHook);
  eventRepository.addEventHook(syncRealtimeHook);
  eventRepository.addEventHook(proactiveIntelligenceHook);

  logger.info(
    "Event broadcasting + domain bridge + materialization + sync real-time + proactive intelligence hooks registered"
  );
  isSetup = true;
}
