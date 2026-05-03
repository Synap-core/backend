/**
 * Event Stream Manager - SSE-based Real-time Event Broadcasting
 *
 * This manager handles Server-Sent Events (SSE) connections for real-time
 * event streaming.
 *
 * Two consumer surfaces:
 *   1. Admin dashboard — `registerClient(controller)` (raw, unfiltered, in-memory).
 *   2. Hub Protocol `/api/hub/events/stream` — `subscribe({filter, onEvent})`,
 *      filtered by userId / entityType (subjectType) / workspaceId.
 *
 * In-memory pubsub only — single-instance fanout. Multi-instance fanout would
 * require Postgres LISTEN/NOTIFY or Redis (deferred follow-up).
 */

import { createLogger } from "@synap-core/core";
import type { EventRecord } from "@synap/database";
import { extractEventInfo, type UnifiedEventData } from "@synap/jobs";

const logger = createLogger({ module: "event-stream-manager" });

/**
 * SSE Client Connection (admin dashboard, raw stream).
 */
interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  connectedAt: Date;
}

/**
 * Filter for `subscribe()` consumers. All fields are AND-combined; undefined
 * fields are wildcards.
 *
 *   userId       — authoritative (the caller's bearer-key user); NEVER wildcard
 *                  for hub callers.
 *   entityType   — matches `EventRecord.subjectType` (e.g. "entity",
 *                  "relation"). Optional.
 *   workspaceId  — single ID, matched against `event.data.workspaceId`. Pass
 *                  `null` to match across all of the user's accessible
 *                  workspaces (caller is responsible for that policy decision).
 *   workspaceIds — alternative: a list of allowed workspace IDs. If both are
 *                  provided, `workspaceIds` takes precedence.
 */
export interface EventSubscribeFilter {
  userId: string;
  entityType?: string;
  workspaceId?: string | null;
  workspaceIds?: string[];
}

export interface EventSubscriber {
  id: string;
  filter: EventSubscribeFilter;
  onEvent: (event: EventRecord) => void | Promise<void>;
}

/**
 * Event Stream Manager
 *
 * Singleton that manages all SSE connections and broadcasts events.
 */
class EventStreamManager {
  private clients: Map<string, SSEClient> = new Map();
  private subscribers: Map<string, EventSubscriber> = new Map();

  /**
   * Register a new SSE client
   */
  registerClient(
    clientId: string,
    controller: ReadableStreamDefaultController
  ): void {
    this.clients.set(clientId, {
      id: clientId,
      controller,
      connectedAt: new Date(),
    });

    logger.info(
      { clientId, totalClients: this.clients.size },
      "SSE client connected"
    );
  }

  /**
   * Unregister an SSE client
   */
  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
    logger.info(
      { clientId, totalClients: this.clients.size },
      "SSE client disconnected"
    );
  }

  /**
   * Subscribe to filtered events.
   *
   * Returns an `unsubscribe()` function — callers MUST invoke it on disconnect
   * or the subscriber will leak.
   *
   * Subscriber `onEvent` callbacks are invoked fire-and-forget (sync return is
   * fine; promise return has `.catch()` attached). A slow or throwing
   * subscriber CANNOT block other subscribers or admin SSE fanout.
   */
  subscribe(subscriber: Omit<EventSubscriber, "id">): () => void {
    const id = crypto.randomUUID();
    this.subscribers.set(id, { ...subscriber, id });
    logger.debug(
      {
        subscriberId: id,
        userId: subscriber.filter.userId,
        entityType: subscriber.filter.entityType,
        workspaceId: subscriber.filter.workspaceId,
        totalSubscribers: this.subscribers.size,
      },
      "Event subscriber registered"
    );
    return () => {
      this.subscribers.delete(id);
      logger.debug(
        { subscriberId: id, totalSubscribers: this.subscribers.size },
        "Event subscriber removed"
      );
    };
  }

  /**
   * Stats for filtered subscribers (used by ops/observability).
   */
  getSubscriberStats(): {
    totalSubscribers: number;
    byUser: Record<string, number>;
  } {
    const byUser: Record<string, number> = {};
    for (const sub of this.subscribers.values()) {
      const u = sub.filter.userId;
      byUser[u] = (byUser[u] ?? 0) + 1;
    }
    return { totalSubscribers: this.subscribers.size, byUser };
  }

  /**
   * Decide whether a given event matches a subscriber's filter.
   * Pure function — exported as a method for testability.
   */
  private matches(event: EventRecord, filter: EventSubscribeFilter): boolean {
    // userId: authoritative — every event must be the subscriber's own.
    if (event.userId !== filter.userId) return false;

    // entityType: matches subject_type column.
    if (filter.entityType && event.subjectType !== filter.entityType)
      return false;

    // workspaceId: from event payload (.data.workspaceId).
    const evtWorkspaceId =
      typeof event.data === "object" && event.data !== null
        ? ((event.data as Record<string, unknown>).workspaceId as
            | string
            | undefined
            | null)
        : undefined;

    if (filter.workspaceIds && filter.workspaceIds.length > 0) {
      if (!evtWorkspaceId) return false;
      if (!filter.workspaceIds.includes(evtWorkspaceId)) return false;
    } else if (
      filter.workspaceId !== undefined &&
      filter.workspaceId !== null
    ) {
      if (evtWorkspaceId !== filter.workspaceId) return false;
    }
    // filter.workspaceId === null OR undefined: no workspace clamp here. The
    // caller has already restricted the user to their accessible workspaces
    // (see hub-protocol /events/stream handler).

    return true;
  }

  /**
   * Broadcast an event to all connected clients
   *
   * @param event - The event record to broadcast
   */
  broadcast(event: EventRecord): void {
    // Fanout to filtered subscribers first (independent of admin clients).
    if (this.subscribers.size > 0) {
      for (const sub of this.subscribers.values()) {
        if (!this.matches(event, sub.filter)) continue;
        // Fire-and-forget — subscriber owns its own backpressure / queueing.
        try {
          const r = sub.onEvent(event);
          if (r && typeof (r as Promise<void>).catch === "function") {
            (r as Promise<void>).catch((err) => {
              logger.warn(
                { subscriberId: sub.id, err },
                "Subscriber onEvent failed (async)"
              );
            });
          }
        } catch (err) {
          logger.warn(
            { subscriberId: sub.id, err },
            "Subscriber onEvent failed (sync)"
          );
        }
      }
    }

    if (this.clients.size === 0) {
      return; // No raw admin clients connected, skip the rest.
    }

    // Parse event type to extract structured info
    let eventInfo: {
      subjectType: string;
      action: string;
      phase: string;
    } | null = null;
    try {
      eventInfo = extractEventInfo(event.eventType);
    } catch {
      // Legacy event format - use raw eventType
      eventInfo = null;
    }

    const data = JSON.stringify({
      id: event.id,
      type: event.eventType,
      timestamp: event.timestamp.toISOString(),
      userId: event.userId,
      subjectId: event.subjectId,
      subjectType: event.subjectType,
      action: eventInfo?.action,
      phase: eventInfo?.phase,
      data: event.data as UnifiedEventData,
      metadata: event.metadata,
      correlationId: event.correlationId,
      causationId: event.causationId,
      source: event.source,
      version: event.version,
    });

    const sseMessage = `data: ${data}\n\n`;
    const encoder = new TextEncoder();
    const encoded = encoder.encode(sseMessage);

    // Broadcast to all connected clients
    const deadClients: string[] = [];

    for (const [clientId, client] of this.clients.entries()) {
      try {
        client.controller.enqueue(encoded);
      } catch (error) {
        logger.warn(
          { clientId, err: error },
          "Failed to send event to client, marking for cleanup"
        );
        deadClients.push(clientId);
      }
    }

    // Cleanup dead clients
    for (const clientId of deadClients) {
      this.unregisterClient(clientId);
    }

    logger.debug(
      {
        eventType: event.eventType,
        clientsSent: this.clients.size - deadClients.length,
        clientsFailed: deadClients.length,
      },
      "Event broadcasted"
    );
  }

  /**
   * Get statistics about connected clients
   */
  getStats(): {
    totalClients: number;
    clients: Array<{ id: string; connectedAt: string }>;
  } {
    return {
      totalClients: this.clients.size,
      clients: Array.from(this.clients.values()).map((client) => ({
        id: client.id,
        connectedAt: client.connectedAt.toISOString(),
      })),
    };
  }

  /**
   * Send a heartbeat to all connected clients to keep connections alive
   */
  sendHeartbeat(): void {
    const heartbeat = ": heartbeat\n\n";
    const encoder = new TextEncoder();
    const encoded = encoder.encode(heartbeat);

    const deadClients: string[] = [];

    for (const [clientId, client] of this.clients.entries()) {
      try {
        client.controller.enqueue(encoded);
      } catch {
        deadClients.push(clientId);
      }
    }

    // Cleanup dead clients
    for (const clientId of deadClients) {
      this.unregisterClient(clientId);
    }
  }
}

/**
 * Singleton instance
 */
export const eventStreamManager = new EventStreamManager();

// Send heartbeat every 30 seconds to keep connections alive
setInterval(() => {
  eventStreamManager.sendHeartbeat();
}, 30000);
