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
 * Metadata carried by every event catalog entry.
 * Used by automation trigger pickers in the frontend.
 */
export interface EventDefinition {
  type: string; // the dot-separated event type used in automation triggers
  /**
   * Alias of `type`, injected by getEventCatalog(). The trigger pickers key off
   * `value` (not `type`) — serving both keeps ONE consistent field across the
   * frontend consumers. Kept optional so the const literals below still satisfy
   * this interface without repeating the string.
   */
  value?: string;
  label: string; // human-readable name for pickers
  domain: string; // grouping in the UI picker
  description: string; // one-line description for picker tooltips
  filterKeys?: string[]; // data keys callers may pass for trigger filtering
}

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
  ENTITY_CREATED: {
    type: "entity.create.completed",
    label: "Entity created",
    domain: "Entity",
    description: "Fires after any entity is successfully created.",
    filterKeys: ["profileSlug"],
  },
  ENTITY_UPDATED: {
    type: "entity.update.completed",
    label: "Entity updated",
    domain: "Entity",
    description: "Fires after any entity field or property is updated.",
    filterKeys: [
      "profileSlug",
      "changedKeys",
      "changed.<fieldName>",
      "<fieldName>",
    ],
  },
  ENTITY_DELETED: {
    type: "entity.delete.completed",
    label: "Entity deleted",
    domain: "Entity",
    description: "Fires after an entity is permanently deleted.",
    filterKeys: ["profileSlug"],
  },

  // ── Focus sessions ─────────────────────────────────────────────────────────
  // Emitted as `focus_session.stage_changed` (action="stage_changed") — the
  // automation-trigger matcher receives the `.completed` wire form, so triggers
  // match the trailing-wildcard pattern `focus_session.stage_changed.*`.
  FOCUS_SESSION_STAGE_CHANGED: {
    type: "focus_session.stage_changed.completed",
    label: "Playbook stage changed",
    domain: "Focus sessions",
    description:
      "Fires when a focus session advances to a different playbook stage.",
    filterKeys: ["toStage", "fromStage", "playbookId"],
  },

  // ── Proposal governance ──────────────────────────────────────────────────
  PROPOSAL_CREATED: {
    type: "proposal.created.completed",
    label: "Proposal created",
    domain: "Proposals",
    description: "A new AI proposal is pending review.",
    filterKeys: ["proposalStatus", "targetType", "changeType"],
  },
  PROPOSAL_APPROVED: {
    type: "proposal.approved.completed",
    label: "Proposal approved",
    domain: "Proposals",
    description: "An AI proposal was approved and applied.",
    filterKeys: ["proposalStatus", "targetType"],
  },
  PROPOSAL_REJECTED: {
    type: "proposal.rejected.completed",
    label: "Proposal rejected",
    domain: "Proposals",
    description: "An AI proposal was rejected.",
    filterKeys: ["proposalStatus", "targetType"],
  },

  // ── Relations ────────────────────────────────────────────────────────────
  RELATION_CREATED: {
    type: "relation.create.completed",
    label: "Relation created",
    domain: "Relations",
    description: "Two entities were linked.",
    filterKeys: ["relationType"],
  },
  RELATION_DELETED: {
    type: "relation.delete.completed",
    label: "Relation deleted",
    domain: "Relations",
    description: "A relation between entities was removed.",
    filterKeys: ["relationType"],
  },

  // ── Documents ────────────────────────────────────────────────────────────
  DOCUMENT_CREATED: {
    type: "document.create.completed",
    label: "Document created",
    domain: "Documents",
    description: "Fires after a document is created.",
    filterKeys: ["profileSlug"],
  },
  DOCUMENT_UPDATED: {
    type: "document.update.completed",
    label: "Document updated",
    domain: "Documents",
    description: "Fires after a document is updated.",
    filterKeys: ["profileSlug"],
  },

  // ── Quick capture ────────────────────────────────────────────────────────
  CAPTURE_COMPLETE: {
    type: "capture.complete.completed",
    label: "Capture completed",
    domain: "Capture",
    description: "A capture finished processing.",
    filterKeys: ["profileSlug"],
  },

  // ── Commands ─────────────────────────────────────────────────────────────
  COMMAND_EXECUTED: {
    type: "command.execute.completed",
    label: "Command executed",
    domain: "Commands",
    description: "Fires after a command finishes execution.",
    filterKeys: ["commandSlug"],
  },

  // ── Connector sync ───────────────────────────────────────────────────────
  CONNECTOR_SYNC_COMPLETE: {
    type: "connector_sync.complete.completed",
    label: "Connector synced",
    domain: "Connectors",
    description: "A connector finished a sync run.",
    filterKeys: ["provider", "syncStatus"],
  },

  // ── Proactive intelligence ───────────────────────────────────────────────
  PROACTIVE_POST: {
    type: "proactive.post.completed",
    label: "Proactive post",
    domain: "Intelligence",
    description: "The proactive AI posted a message into your channel.",
    filterKeys: ["proactiveType"],
  },

  // ── Notifications ────────────────────────────────────────────────────────
  NOTIFICATION_CREATED: {
    type: "notification.created.completed",
    label: "Notification created",
    domain: "Notifications",
    description: "A notification was raised.",
    filterKeys: ["notificationType", "category"],
  },

  // ── Channel messages ─────────────────────────────────────────────────────
  CHANNEL_MESSAGE_CREATED: {
    type: "channel_message.created.completed",
    label: "Channel message created",
    domain: "Messaging",
    description: "A new message was posted into a Synap channel.",
    filterKeys: ["channelId", "messageRole"],
  },

  // ── Feed items ───────────────────────────────────────────────────────────
  FEED_NEW_ITEM: {
    type: "feed.new_item.completed",
    label: "Feed new item",
    domain: "Feed",
    description: "A new item appeared in the intelligence feed.",
    filterKeys: ["feedArchetype", "feedMinRelevanceScore"],
  },

  // ── External messaging ───────────────────────────────────────────────────
  EXTERNAL_MESSAGE_RECEIVED: {
    type: "external_message.received.completed",
    label: "External message received",
    domain: "Messaging",
    description: "An inbound message arrived on a connected external channel.",
    filterKeys: ["provider", "channelId"],
  },
  EXTERNAL_CHANNEL_CREATED: {
    type: "external_channel.created.completed",
    label: "External channel created",
    domain: "Messaging",
    description: "A new external conversation channel was auto-created.",
    filterKeys: ["provider"],
  },
  MESSAGING_ACCOUNT_CREATED: {
    type: "messaging_account.created.completed",
    label: "Messaging account connected",
    domain: "Messaging",
    description: "A messaging account was connected.",
    filterKeys: ["provider"],
  },
  MESSAGING_ACCOUNT_RECONNECTION_REQUIRED: {
    type: "messaging_account.reconnection_required.completed",
    label: "Messaging account needs reconnection",
    domain: "Messaging",
    description: "A messaging account requires reconnection.",
    filterKeys: ["provider"],
  },
  MESSAGING_ACCOUNT_DISCONNECTED: {
    type: "messaging_account.disconnected.completed",
    label: "Messaging account disconnected",
    domain: "Messaging",
    description: "A messaging account was disconnected.",
    filterKeys: ["provider"],
  },

  // ── Inbox items ──────────────────────────────────────────────────────────
  INBOX_ITEM_RECEIVED: {
    type: "inbox_item.received.completed",
    label: "Inbox item received",
    domain: "Inbox",
    description: "A new item arrived from an external integration.",
    filterKeys: ["sourceType"],
  },
  INBOX_ITEM_ANALYZED: {
    type: "inbox_item.analyzed.completed",
    label: "Inbox item analyzed",
    domain: "Inbox",
    description: "An inbox item was analyzed by the intelligence service.",
    filterKeys: ["sourceType"],
  },

  // ── User / identity ──────────────────────────────────────────────────────
  USER_UPDATED: {
    type: "user.updated.completed",
    label: "User updated",
    domain: "Identity",
    description: "A user identity was updated.",
    filterKeys: [],
  },
} as const satisfies Record<string, EventDefinition>;

export type OperationalEventType =
  (typeof OperationalEventTypes)[keyof typeof OperationalEventTypes]["type"];

/**
 * Convenience: get the type string from a catalog key.
 */
export function getEventType<K extends keyof typeof OperationalEventTypes>(
  key: K
): (typeof OperationalEventTypes)[K]["type"] {
  return OperationalEventTypes[key].type;
}

/**
 * Helper to get all picker-visible entries for frontend.
 */
export function getEventCatalog(): EventDefinition[] {
  // Inject `value` as an alias of `type` — the picker consumers read `value`.
  return Object.values(OperationalEventTypes).map((e) => ({
    ...e,
    value: e.type,
  })) as EventDefinition[];
}

// ============================================================================
// COMBINED EVENT TYPES
// ============================================================================

/**
 * EventTypes — all operational + system event type constants.
 * This is the complete set of strings that automation triggers can match.
 * Each entry is the `.type` string for backwards-compatibility with callers
 * that spread this object.
 */
export const EventTypes = {
  ...SystemEventTypes,
  ...Object.fromEntries(
    Object.entries(OperationalEventTypes).map(([k, v]) => [k, v.type])
  ),
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
  const operationalTypes = Object.values(OperationalEventTypes).map(
    (e) => e.type
  );
  if (
    Object.values(SystemEventTypes).includes(eventType as SystemEventType) ||
    operationalTypes.includes(eventType as OperationalEventType)
  ) {
    return true;
  }
  return isGeneratedEventType(eventType);
}

/**
 * All operational + system event type strings as a readonly array.
 */
export function getAllEventTypes(): readonly EventType[] {
  const operationalTypes = Object.values(OperationalEventTypes).map(
    (e) => e.type as OperationalEventType
  );
  return [
    ...(Object.values(SystemEventTypes) as SystemEventType[]),
    ...operationalTypes,
  ];
}
