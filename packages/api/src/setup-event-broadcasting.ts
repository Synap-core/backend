/**
 * Setup Event Broadcasting Hook
 *
 * This module registers a hook with the EventRepository to broadcast
 * all appended events to connected SSE clients in real-time.
 *
 * Call setupEventBroadcasting() at application startup.
 */

import { eventRepository, type EventHook } from '@synap/database';
import { eventStreamManager } from './event-stream-manager.js';
import { createLogger } from '@synap-core/core';

const logger = createLogger({ module: 'event-broadcasting' });

let isSetup = false;

/**
 * Setup event broadcasting to SSE clients
 *
 * This function should be called once at application startup.
 * It registers a hook with the EventRepository to broadcast events.
 */
export function setupEventBroadcasting(): void {
  if (isSetup) {
    logger.warn('Event broadcasting already setup, skipping');
    return;
  }

  const broadcastHook: EventHook = (event) => {
    // Broadcast to all connected SSE clients
    eventStreamManager.broadcast(event);
  };

  // Register the hook
  eventRepository.addEventHook(broadcastHook);

  logger.info('Event broadcasting hook registered with EventRepository');
  isSetup = true;
}
