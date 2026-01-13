/**
 * Event Stream Manager - SSE-based Real-time Event Broadcasting
 *
 * This manager handles Server-Sent Events (SSE) connections for real-time
 * event streaming to the admin dashboard.
 *
 * Features:
 * - Multiple concurrent SSE connections
 * - Broadcast events to all connected clients
 * - Automatic connection cleanup
 */

import { createLogger } from "@synap-core/core";
import type { EventRecord } from "@synap/database";

const logger = createLogger({ module: "event-stream-manager" });

/**
 * SSE Client Connection
 */
interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  connectedAt: Date;
}

/**
 * Event Stream Manager
 *
 * Singleton that manages all SSE connections and broadcasts events.
 */
class EventStreamManager {
  private clients: Map<string, SSEClient> = new Map();

  /**
   * Register a new SSE client
   */
  registerClient(
    clientId: string,
    controller: ReadableStreamDefaultController,
  ): void {
    this.clients.set(clientId, {
      id: clientId,
      controller,
      connectedAt: new Date(),
    });

    logger.info(
      { clientId, totalClients: this.clients.size },
      "SSE client connected",
    );
  }

  /**
   * Unregister an SSE client
   */
  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
    logger.info(
      { clientId, totalClients: this.clients.size },
      "SSE client disconnected",
    );
  }

  /**
   * Broadcast an event to all connected clients
   *
   * @param event - The event record to broadcast
   */
  broadcast(event: EventRecord): void {
    if (this.clients.size === 0) {
      return; // No clients connected, skip
    }

    const data = JSON.stringify({
      id: event.id,
      type: event.eventType,
      timestamp: event.timestamp.toISOString(),
      userId: event.userId,
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      data: event.data,
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
          "Failed to send event to client, marking for cleanup",
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
      "Event broadcasted",
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
      } catch (error) {
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
