/**
 * Event Dispatcher - Phase 2: Worker Layer
 * 
 * Central Inngest function that receives all events and dispatches them
 * to the appropriate handlers based on event type.
 * 
 * This is the "router" of the event-driven architecture:
 * - Receives events from the event bus (api/event.logged)
 * - Converts Inngest event format to SynapEvent format
 * - Finds handlers registered for the event type
 * - Executes each handler safely within step.run() for retry safety
 */

import { inngest } from '../client.js';
import { handlerRegistry } from '../handlers/registry.js';
import { parseSynapEvent, type SynapEvent } from '@synap/types';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'event-dispatcher' });

/**
 * Convert Inngest event format to SynapEvent format
 * 
 * The Inngest event comes from api/event.logged and contains:
 * - id, type, data, timestamp, userId, etc.
 * 
 * We convert it to the SynapEvent format for handler consumption.
 */
function convertToSynapEvent(inngestEvent: {
  data: {
    id: string;
    type: string;
    data: Record<string, unknown>;
    timestamp: string | Date;
    userId: string;
    aggregateId?: string;
    aggregateType?: string;
    version?: number;
    metadata?: Record<string, unknown> | null;
    causationId?: string;
    correlationId?: string;
    source?: string;
    requestId?: string;
  };
}): SynapEvent {
  const eventData = inngestEvent.data;
  
  // Convert timestamp to Date if it's a string
  const timestamp = eventData.timestamp instanceof Date
    ? eventData.timestamp
    : new Date(eventData.timestamp);

  // Extract requestId from metadata if present
  const requestId = eventData.requestId || 
    (eventData.metadata && typeof eventData.metadata === 'object' && 'requestId' in eventData.metadata
      ? String(eventData.metadata.requestId)
      : undefined);

  // Build SynapEvent
  const synapEvent: SynapEvent = {
    id: eventData.id,
    version: 'v1',
    type: eventData.type,
    aggregateId: eventData.aggregateId,
    data: eventData.data,
    userId: eventData.userId,
    source: (eventData.source as SynapEvent['source']) || 'api',
    timestamp,
    correlationId: eventData.correlationId,
    causationId: eventData.causationId,
    requestId,
  };

  // Validate and return
  return parseSynapEvent(synapEvent);
}

/**
 * Event Dispatcher Inngest Function
 * 
 * This function:
 * 1. Listens to 'api/event.logged' events
 * 2. Converts them to SynapEvent format
 * 3. Finds all handlers registered for the event type
 * 4. Executes each handler safely within step.run()
 * 
 * Each handler execution is independent and retryable.
 */
export const eventDispatcher = inngest.createFunction(
  {
    id: 'event-dispatcher',
    name: 'Event Dispatcher',
  },
  {
    event: 'api/event.logged',
  },
  async ({ event, step }) => {
    const eventType = event.data.type;
    logger.info({ eventType, eventId: event.data.id }, 'Dispatching event to handlers');

    // Convert Inngest event to SynapEvent format
    const synapEventRaw = await step.run('convert-event', async () => {
      return convertToSynapEvent(event as Parameters<typeof convertToSynapEvent>[0]);
    });
    
    // Ensure timestamp is a Date object (convertToSynapEvent returns Date, but TypeScript may not infer it)
    const timestampValue = synapEventRaw.timestamp as unknown;
    const synapEvent: SynapEvent = {
      ...synapEventRaw,
      timestamp: timestampValue instanceof Date 
        ? timestampValue 
        : new Date(timestampValue as string),
    };

    // Find all handlers for this event type
    const handlers = handlerRegistry.getHandlers(eventType);

    if (handlers.length === 0) {
      logger.debug({ eventType }, 'No handlers registered for event type');
      return {
        status: 'no-handlers',
        eventType,
        eventId: synapEvent.id,
      };
    }

    logger.debug(
      { eventType, handlerCount: handlers.length },
      'Found handlers for event type'
    );

    // Execute each handler independently
    // We do NOT wrap in step.run here because handlers use step.run internally
    // and Inngest does not support nested steps.
    const results = await Promise.allSettled(
      handlers.map(async (handler) => {
        try {
          logger.debug(
            { handlerEventType: handler.eventType, eventId: synapEvent.id },
            'Executing handler'
          );
          
          // Pass the step object directly
          const result = await handler.handle(synapEvent, step);
          
          logger.info(
            {
              handlerEventType: handler.eventType,
              eventId: synapEvent.id,
              success: result.success,
            },
            'Handler completed'
          );
          return result;
        } catch (error) {
          logger.error(
            {
              err: error,
              handlerEventType: handler.eventType,
              eventId: synapEvent.id,
            },
            'Handler execution failed'
          );
          return {
            success: false,
            message: `Handler failed: ${error instanceof Error ? error.message : String(error)}`,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    // Summarize results
    const successful = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.length - successful;

    return {
      status: 'dispatched',
      eventType,
      eventId: synapEvent.id,
      handlerCount: handlers.length,
      successful,
      failed,
      results: results.map((r, i) => ({
        handler: handlers[i].eventType,
        status: r.status,
        result: r.status === 'fulfilled' ? r.value : { error: String(r.reason) },
      })),
    };
  }
);

