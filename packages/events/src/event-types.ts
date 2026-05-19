/**
 * Event Types — Single Source of Truth for Automation-Triggerable Events
 *
 * OperationalEventTypes defines every event string that:
 *   1. emitSideEffects() can produce (via the "automation-trigger-match" pg-boss queue)
 *   2. Automation trigger configs can reference in their eventPattern field
 *   3. IS agents can query via GET /api/hub/events?types[]=...
 *
 * Pattern: {singular-domain}.{action}.{modifier}
 *   entity.create.completed   ← entity created (emitSideEffects: subjectType="entity", action="create")
 *   capture.complete.completed ← quick capture pipeline finished
 *
 * Note: GeneratedEventTypes (in generator.ts) uses a different pattern
 * ({plural-table}.{action}.{validated}) for schema-level documentation and
 * admin introspection. Those strings are NOT what automation triggers match.
 */

// ============================================================================
// SYSTEM EVENTS (cross-cutting operations)
// ============================================================================

/**
 * System Event Types
 *
 * Events for system-wide operations that don't map to specific tables.
 * Following pattern: {domain}.{action}.{modifier}
 */
export const SystemEventTypes = {
  // Webhook delivery - triggered after any event
  WEBHOOK_DELIVERY: "webhooks.deliver.requested",
} as const;

export type SystemEventType =
  (typeof SystemEventTypes)[keyof typeof SystemEventTypes];

// ============================================================================
// OPERATIONAL EVENTS (cross-domain pipeline events)
// ============================================================================

/**
 * Operational Event Types
 *
 * Events emitted by backend workers, cron jobs, and pipeline completions.
 * These are the events that automations react to, and that land in the event log.
 *
 * Pattern: {domain}.{action}.{modifier}
 */
export const OperationalEventTypes = {
  // ── Entity lifecycle ─────────────────────────────────────────────────────
  ENTITY_CREATED: "entity.create.completed",
  ENTITY_UPDATED: "entity.update.completed",
  ENTITY_DELETED: "entity.delete.completed",

  // ── Proposal governance ──────────────────────────────────────────────────
  PROPOSAL_CREATED: "proposal.created.completed",
  PROPOSAL_APPROVED: "proposal.approved.completed",
  PROPOSAL_REJECTED: "proposal.rejected.completed",

  // ── Relations ────────────────────────────────────────────────────────────
  RELATION_CREATED: "relation.create.completed",
  RELATION_DELETED: "relation.delete.completed",

  // ── Quick capture ────────────────────────────────────────────────────────
  CAPTURE_COMPLETE: "capture.complete.completed",

  // ── Connector sync ───────────────────────────────────────────────────────
  CONNECTOR_SYNC_COMPLETE: "connector_sync.complete.completed",

  // ── Proactive intelligence ───────────────────────────────────────────────
  PROACTIVE_POST: "proactive.post.completed",

  // ── Notifications ────────────────────────────────────────────────────────
  NOTIFICATION_CREATED: "notification.created",

  // ── Channel messages ─────────────────────────────────────────────────────
  CHANNEL_MESSAGE_CREATED: "channel_message.created.completed",

  // ── Feed items ───────────────────────────────────────────────────────────
  /** Fires once per entity created from the feed pipeline (post-classification, post-threshold). */
  FEED_NEW_ITEM: "feed.new_item.completed",

  // ── External messaging ───────────────────────────────────────────────────
  /**
   * Fires when an inbound message arrives on an external conversation thread
   * that is linked to a CRM entity via an EXTERNAL channel.
   * data: { entityId, provider, threadId, participantName, messagePreview, channelId }
   */
  EXTERNAL_MESSAGE_RECEIVED: "external_message.received.completed",
} as const;

export type OperationalEventType =
  (typeof OperationalEventTypes)[keyof typeof OperationalEventTypes];

// ============================================================================
// COMBINED EVENT TYPES
// ============================================================================

/**
 * EventTypes — all operational + system event type constants.
 * This is the complete set of strings that automation triggers can match.
 */
export const EventTypes = {
  ...SystemEventTypes,
  ...OperationalEventTypes,
} as const;

/**
 * All possible event type values
 */
export type EventType = SystemEventType | OperationalEventType;

// Imported statically to fix ESM 'require is not defined' error
import { isGeneratedEventType } from "./generator.js";

/**
 * Check if a string is a known event type.
 * Covers both OperationalEventTypes and GeneratedEventTypes (schema-level).
 */
export function isValidEventType(eventType: string): boolean {
  if (Object.values(EventTypes).includes(eventType as EventType)) return true;
  return isGeneratedEventType(eventType);
}

/**
 * All operational + system event type strings as a readonly array.
 */
export function getAllEventTypes(): readonly EventType[] {
  return Object.values(EventTypes);
}
