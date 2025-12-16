/**
 * Type-Safe Event Publisher
 * 
 * Provides a type-safe way to publish domain events.
 * Automatically handles subjectId, subjectType, and validation.
 */

import { db, events } from '@synap/database';
import type { DomainEvent, EventDataFor } from './domain-events.js';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'event-publisher' });

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
 * Publish a domain event
 * 
 * This function is type-safe: the event parameter must be a valid DomainEvent
 * with the correct type, subjectId, subjectType, and data shape.
 * 
 * @example
 * ```typescript
 * await publishEvent({
 *   type: 'inbox.item.received',
 *   subjectId: itemId,
 *   subjectType: 'inbox_item',
 *   data: {
 *     provider: 'gmail',
 *     externalId: '123',
 *     // ... fully typed!
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
  }, 'Publishing event');
  
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
  
  logger.debug({ eventId: result.id }, 'Event published');
  
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
