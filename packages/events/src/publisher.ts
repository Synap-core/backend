/**
 * Type-Safe Event Publisher
 *
 * Dual-Write Pattern:
 * 1. Saves event to TimescaleDB (audit trail, source of truth)
 * 2. Sends to pg-boss (triggers workers for side-effect processing)
 *
 * This ensures both persistence AND real-time processing.
 */

import { db, events } from "@synap/database";
import type { DomainEvent, EventDataFor } from "./domain-events.js";
import { createLogger } from "@synap-core/core";
const logger = createLogger({ module: "event-publisher" });

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
  logger.debug(
    {
      type: event.type,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
    },
    "Publishing event (dual-write)"
  );

  // STEP 1: Save to TimescaleDB (source of truth)
  const [result] = await db
    .insert(events)
    .values({
      type: event.type,
      subjectId: event.subjectId,
      subjectType: event.subjectType,
      data: event.data as any, // Cast needed for JSONB
      userId: options.userId,
      source: options.source,
      metadata: options.metadata,
      correlationId: options.correlationId,
    })
    .returning({ id: events.id });

  logger.debug({ eventId: result.id }, "Event saved to TimescaleDB");

  // Side-effects (search indexing, embedding, etc.) are handled by routers
  // via emitSideEffects() from @synap/jobs — no need to duplicate here.

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
  data: EventDataFor<"inbox.item.received">
) {
  return {
    type: "inbox.item.received" as const,
    subjectId: itemId,
    subjectType: "inbox_item" as const,
    data,
  };
}

/**
 * Create an inbox item analyzed event
 */
export function createInboxItemAnalyzedEvent(
  itemId: string,
  data: EventDataFor<"inbox.item.analyzed">
) {
  return {
    type: "inbox.item.analyzed" as const,
    subjectId: itemId,
    subjectType: "inbox_item" as const,
    data,
  };
}

/**
 * Create an inbox item status updated event
 */
export function createInboxItemStatusUpdatedEvent(
  itemId: string,
  data: EventDataFor<"inbox.item.status.updated">
) {
  return {
    type: "inbox.item.status.updated" as const,
    subjectId: itemId,
    subjectType: "inbox_item" as const,
    data,
  };
}

/**
 * Create an entity create requested event
 */
export function createEntityCreateRequestedEvent(
  entityId: string,
  data: EventDataFor<"entities.create.requested">
) {
  return {
    type: "entities.create.requested" as const,
    subjectId: entityId,
    subjectType: "entity" as const,
    data,
  };
}

/**
 * Create an entity create completed event
 */
export function createEntityCreateCompletedEvent(
  entityId: string,
  data: EventDataFor<"entities.create.completed">
) {
  return {
    type: "entities.create.completed" as const,
    subjectId: entityId,
    subjectType: "entity" as const,
    data,
  };
}

// Add more builder helpers as needed...
