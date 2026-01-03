/**
 * Type-Safe Event Publisher
 * 
 * Dual-Write Pattern:
 * 1. Saves event to TimescaleDB (audit trail, source of truth)
 * 2. Sends to Inngest (triggers workers for processing)
 * 
 * This ensures both persistence AND real-time processing.
 */

import { db, events, sql } from '@synap/database';
import type { DomainEvent, EventDataFor } from './domain-events.js';
import { createLogger } from '@synap-core/core';
import { Inngest } from 'inngest';

const logger = createLogger({ module: 'event-publisher' });

// Create Inngest client for event publishing
// Note: This is separate from @synap/jobs client to avoid circular dependencies
const inngest = new Inngest({
  id: 'synap-events-publisher',
  name: 'Synap Event Publisher',
});

// ============================================================================
// PUBLISH OPTIONS
// ============================================================================

export interface PublishEventOptions {
  /** User ID who owns this event */
  userId: string;
  /** Where this event came from (api, n8n-webhook, intelligence-callback, etc.) */
  source?: string;
  /** Additional metadata about the event */
  metadata?: Record<string, unknown>;
  /** Correlation ID for tracing related events */
  correlationId?: string;
}

// ============================================================================
// TYPE-SAFE PUBLISHER
// ============================================================================

/**
 * Publish a domain event (Dual-Write Pattern)
 * 
 * 1. Saves to TimescaleDB (audit trail, source of truth)
 * 2. Sends to Inngest (triggers workers)
 * 
 * If Inngest send fails, marks event with retry metadata.
 * Background job will retry later.
 * 
 * @example
 * ```typescript
 * await publishEvent({
 *   type: 'entities.create.requested',
 *   subjectId: entityId,
 *   subjectType: 'entity',
 *   data: {
 *     entityType: 'note',
 *     title: 'My Note',
 *   }
 * }, { userId: 'user_123' });
 * ```
 */
export async function publishEvent<T extends DomainEvent>(
  event: T,
  options: PublishEventOptions
): Promise<{ eventId: string }> {
  logger.debug({ 
    type: event.type, 
    subjectType: event.subjectType,
    subjectId: event.subjectId 
  }, 'Publishing event (dual-write)');
  
  // STEP 1: Save to TimescaleDB (source of truth)
  const [result] = await db.insert(events).values({
    type: event.type,
    subjectId: event.subjectId,
    subjectType: event.subjectType,
    data: event.data as any, // Cast needed for JSONB
    userId: options.userId,
    source: options.source,
    metadata: options.metadata,
    correlationId: options.correlationId,
  }).returning({ id: events.id });
  
  logger.debug({ eventId: result.id }, 'Event saved to TimescaleDB');
  
  // STEP 2: Send to Inngest (trigger workers)
  try {
    await inngest.send({
      name: event.type,
      data: {
        eventId: result.id, // Reference to DB record
        subjectId: event.subjectId,
        subjectType: event.subjectType,
        ...event.data,
      },
      user: {
        id: options.userId,
      },
    });
    
    logger.debug({ eventId: result.id, type: event.type }, 'Event sent to Inngest');
  } catch (error) {
    logger.error(
      { err: error, eventId: result.id, type: event.type },
      'Failed to send event to Inngest - marking for retry'
    );
    
    // Mark event for retry (background job will pick this up)
    await sql`
      UPDATE events 
      SET metadata = ${JSON.stringify({
        ...options.metadata,
        inngest_pending: true,
        inngest_retry_count: 0,
        inngest_last_error: String(error),
      })}::jsonb 
      WHERE id = ${result.id}
    `;
    
    // Don't throw - event is saved, retry will handle Inngest
    logger.warn({ eventId: result.id }, 'Event will be retried by background job');
  }
  
  return { eventId: result.id };
}

// ============================================================================
// EVENT BUILDER HELPERS
// ============================================================================

/**
 * Create an inbox item received event
 */
export function createInboxItemReceivedEvent(
  itemId: string,
  data: EventDataFor<'inbox.item.received'>
) {
  return {
    type: 'inbox.item.received' as const,
    subjectId: itemId,
    subjectType: 'inbox_item' as const,
    data,
  };
}

/**
 * Create an inbox item analyzed event
 */
export function createInboxItemAnalyzedEvent(
  itemId: string,
  data: EventDataFor<'inbox.item.analyzed'>
) {
  return {
    type: 'inbox.item.analyzed' as const,
    subjectId: itemId,
    subjectType: 'inbox_item' as const,
    data,
  };
}

/**
 * Create an inbox item status updated event
 */
export function createInboxItemStatusUpdatedEvent(
  itemId: string,
  data: EventDataFor<'inbox.item.status.updated'>
) {
  return {
    type: 'inbox.item.status.updated' as const,
    subjectId: itemId,
    subjectType: 'inbox_item' as const,
    data,
  };
}

/**
 * Create an entity create requested event
 */
export function createEntityCreateRequestedEvent(
  entityId: string,
  data: EventDataFor<'entities.create.requested'>
) {
  return {
    type: 'entities.create.requested' as const,
    subjectId: entityId,
    subjectType: 'entity' as const,
    data,
  };
}

/**
 * Create an entity create completed event
 */
export function createEntityCreateCompletedEvent(
  entityId: string,
  data: EventDataFor<'entities.create.completed'>
) {
  return {
    type: 'entities.create.completed' as const,
    subjectId: entityId,
    subjectType: 'entity' as const,
    data,
  };
}

// Add more builder helpers as needed...
