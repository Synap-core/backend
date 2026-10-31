/**
 * Domain Event Types
 *
 * Type definitions for Socket.IO domain events.
 * These are emitted by pg-boss workers via the realtime bridge
 * to notify clients about data changes.
 *
 * SINGLE SOURCE OF TRUTH - Frontend imports from here.
 */

import type { Entity } from "../index.js";

// =============================================================================
// Entity Events
// =============================================================================

export interface EntityCreatedEvent {
  entityId: string;
  workspaceId: string;
  type: string;
  title: string;
  entity?: Entity; // Added for optimistic updates
  createdBy: string;
  createdAt: string;
}

export interface EntityUpdatedEvent {
  entityId: string;
  workspaceId: string;
  changes: Record<string, unknown>;
  entity?: Entity; // Added for optimistic updates
  updatedBy: string;
  updatedAt: string;
}

export interface EntityDeletedEvent {
  entityId: string;
  workspaceId: string;
  deletedBy: string;
  deletedAt: string;
}

export interface EntityApprovalEvent {
  requestId: string;
  entityId?: string;
  workspaceId: string;
  entityType: string;
  status: "pending" | "approved" | "rejected" | "created";
  reason?: string;
  createdBy: string;
  timestamp: string;
}

// =============================================================================
// Document Events
// =============================================================================

export interface DocumentUpdatedEvent {
  documentId: string;
  workspaceId: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface DocumentVersionCreatedEvent {
  documentId: string;
  workspaceId: string;
  version: number;
  message?: string;
  createdBy: string;
  createdAt: string;
}

// =============================================================================
// Actor-prefixed events ({actor}:{entity}:{action}) — see docstring on EventNames
// =============================================================================

/** Platforms an external agent bridges into Synap channels. */
export type ExternalMessagePlatform =
  "telegram" | "whatsapp" | "signal" | "matrix" | "discord" | "voice";

/**
 * External chat platform message ingested by an external agent → routed into a
 * Synap channel. Emitted on the wire as `openclaw:message:received`: a legacy
 * NAME (Eve's dashboard listens for it), not an OpenClaw dependency — the
 * event fires for any agent that relays through `sendExternalMessage`.
 * Cut-over: add a generic name, move Eve's dashboard, then drop this one.
 */
export interface ExternalMessageReceivedEvent {
  channelId: string;
  messageId: string;
  platform: ExternalMessagePlatform;
  /** Short preview of the message body. Truncated upstream — no PII normalization here. */
  excerpt: string;
  /** ISO-8601 timestamp from when the bridge accepted the inbound message. */
  receivedAt: string;
}

/** Synap (the brain) routed an outbound assistant reply back to an external platform. */
export interface SynapReplyRoutedEvent {
  channelId: string;
  messageId: string;
  /** External platform identifier (e.g. "telegram", "voice", "email"). */
  targetPlatform: string;
  excerpt: string;
  /** ISO-8601 timestamp at which the reply was handed to the egress connector. */
  routedAt: string;
}

export interface ImportFileProgressEvent {
  batchId: string;
  path: string;
  index: number;
  total: number;
  status: "processing" | "done" | "error";
  error?: string;
}

/**
 * What finished on a Library item: its read (`importRead` written — read, not
 * read, blocked, waiting to retry) or its media copy (`importMedia*` written —
 * a reader's copy or the person's "Try again").
 */
export const LIBRARY_ITEM_UPDATES = ["read", "media"] as const;
export type LibraryItemUpdate = (typeof LIBRARY_ITEM_UPDATES)[number];

/**
 * A Library item changed in the background (a light-read job, a media copy):
 * sent to the OWNER's room only (`user:<id>`). It names what to refetch and
 * carries no content — a client invalidates its Library queries for the item
 * (and the groups it is in) and reads the item through the Library doors.
 */
export interface LibraryItemUpdatedEvent {
  /** The Library item (`documents.id`). */
  itemId: string;
  /** The groups the item is in, when it is in any (their counts may have moved). */
  groupIds?: string[];
  what: LibraryItemUpdate;
}

// =============================================================================
// AI Events
// =============================================================================

export interface AIProposalEvent {
  /** UUID of the proposal row — pass to proposals.approve/reject */
  proposalId: string;
  /** Channel/thread the AI message was sent to */
  threadId: string;
  /** User message that triggered this proposal */
  messageId: string;
  /** Tool that created the proposal (e.g. "create_entity", "update_document") */
  toolName: string;
  /** Human-readable description of the proposed action */
  description: string;
  /** Agent user that triggered the proposal (if available) */
  agentUserId?: string;
}

export interface AIProposalStatusEvent {
  proposalId: string;
  workspaceId: string;
  status: "approved" | "rejected";
  processedBy: string;
  processedAt: string;
}

// =============================================================================
// Chat Events
// =============================================================================

export interface ChatMessageEvent {
  threadId: string;
  messageId: string;
  workspaceId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ChatStreamEvent {
  threadId: string;
  messageId: string;
  chunk: string;
  done: boolean;
}

// =============================================================================
// UI Events
// =============================================================================

/**
 * Payload for `ui:focus` — tells the browser to open a specific surface
 * (entity, view, cell, document, channel, or app).
 */
export interface UiFocusEvent {
  surface: {
    kind: "cell" | "view" | "entity" | "document" | "channel" | "app";
    // kind=cell
    cellKey?: string;
    props?: Record<string, unknown>;
    // kind=view
    viewId?: string;
    // kind=entity
    entityId?: string;
    // kind=document
    documentId?: string;
    // kind=channel
    channelId?: string;
    // kind=app
    appId?: string;
    // shared
    placement?: "main" | "side";
    title?: string;
    workspaceId?: string;
  };
}

// =============================================================================
// Server to Client Events Map
// =============================================================================

/**
 * All domain events emitted from server to client.
 * Use this for typed Socket.IO client setup.
 */
export interface DomainServerToClientEvents {
  // Entities
  "entity:created": (data: EntityCreatedEvent) => void;
  "entity:updated": (data: EntityUpdatedEvent) => void;
  "entity:deleted": (data: EntityDeletedEvent) => void;
  "entity:approval": (data: EntityApprovalEvent) => void;

  // Documents
  "document:updated": (data: DocumentUpdatedEvent) => void;
  "document:version": (data: DocumentVersionCreatedEvent) => void;

  // AI
  "ai:proposal": (data: AIProposalEvent) => void;
  "ai:proposal:status": (data: AIProposalStatusEvent) => void;

  // Chat
  "chat:message": (data: ChatMessageEvent) => void;
  "chat:stream": (data: ChatStreamEvent) => void;

  // {actor}:{entity}:{action} — new convention. New events MUST land here, not above.
  "openclaw:message:received": (data: ExternalMessageReceivedEvent) => void;
  "synap:reply:routed": (data: SynapReplyRoutedEvent) => void;
  "import:file:progress": (data: ImportFileProgressEvent) => void;
  "library:item:updated": (data: LibraryItemUpdatedEvent) => void;

  // UI gateway
  "ui:focus": (data: UiFocusEvent) => void;

  // System
  error: (data: { code: string; message: string }) => void;
}

// =============================================================================
// Client to Server Events Map
// =============================================================================

/**
 * Events clients can send to server.
 * Presence namespace: join/leave-room for dynamic room subscription; join/leave-workspace and join/leave-document are semantic aliases (server may map to same rooms).
 */
export interface DomainClientToServerEvents {
  // Room management (generic; server joins/leaves Socket.IO rooms by id)
  "join-room": (roomId: string) => void;
  "leave-room": (roomId: string) => void;
  // Semantic room management (optional; server can map to join-room)
  "join-workspace": (workspaceId: string) => void;
  "leave-workspace": (workspaceId: string) => void;
  "join-document": (documentId: string) => void;
  "leave-document": (documentId: string) => void;
}

// =============================================================================
// Event Names
// =============================================================================

/**
 * Legacy 2-segment event-name registry. Kept exported because external
 * consumers (browser hooks, SDK clients) still depend on it.
 *
 * @deprecated since 2026-05-05 — use {@link EventNames} for new code. The new
 * convention is `{actor}:{entity}:{action}` (three segments, lowercase). Do
 * not add entries here.
 */
export const DomainEventNames = {
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  ENTITY_CREATED: "entity:created",
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  ENTITY_UPDATED: "entity:updated",
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  ENTITY_DELETED: "entity:deleted",
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  DOCUMENT_UPDATED: "document:updated",
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  DOCUMENT_VERSION: "document:version",
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  AI_PROPOSAL: "ai:proposal",
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  AI_PROPOSAL_STATUS: "ai:proposal:status",
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  CHAT_MESSAGE: "chat:message",
  /** @deprecated since 2026-05-05 — legacy 2-segment naming. New events use `{actor}:{entity}:{action}`. Do not remove; existing consumers still depend on these. */
  CHAT_STREAM: "chat:stream",
} as const;

export type DomainEventName =
  (typeof DomainEventNames)[keyof typeof DomainEventNames];

/**
 * Canonical event-name registry. Pattern: `{actor}:{entity}:{action}` —
 * three segments, lowercase, colon-delimited.
 *
 * Actor vocabulary:
 * - `user` — direct human action
 * - `agent` — Synap agent (orchestrator, persona)
 * - `openclaw` — LEGACY name of messaging ingress (external chat → Synap);
 *   see {@link ExternalMessageReceivedEvent}. Do not use it for new events.
 * - `synap` — the brain (notifications, channel routing, AI streaming)
 * - `system` — infra / cron / lifecycle
 *
 * Add new events at the bottom under the `{actor}:{entity}:{action}` block.
 * Never add new 2-segment entries — those are kept for backwards compatibility
 * only.
 */
export const EventNames = {
  // Legacy (2-segment, backwards-compat) — DO NOT add more like these.
  ENTITY_CREATED: "entity:created",
  ENTITY_UPDATED: "entity:updated",
  ENTITY_DELETED: "entity:deleted",
  DOCUMENT_UPDATED: "document:updated",
  DOCUMENT_VERSION: "document:version",
  AI_PROPOSAL: "ai:proposal",
  AI_PROPOSAL_STATUS: "ai:proposal:status",
  CHAT_MESSAGE: "chat:message",
  CHAT_STREAM: "chat:stream",

  // {actor}:{entity}:{action} — NEW convention. Add new events here.
  EXTERNAL_MESSAGE_RECEIVED: "openclaw:message:received", // legacy wire name
  SYNAP_REPLY_ROUTED: "synap:reply:routed",
  IMPORT_FILE_PROGRESS: "import:file:progress",
  /** A Library item's read or media copy finished (owner's room only). */
  LIBRARY_ITEM_UPDATED: "library:item:updated",

  // UI gateway
  UI_FOCUS: "ui:focus",
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];

/**
 * Maps an event name to its payload shape via {@link DomainServerToClientEvents}.
 * Lets `emitTyped<E>` infer the right payload from the event name alone, so
 * `emitTyped("synap:reply:routed", { ... })` is type-checked at the call site.
 */
export type EventPayloadFor<E extends EventName> =
  E extends keyof DomainServerToClientEvents
    ? Parameters<DomainServerToClientEvents[E]>[0]
    : never;

// Unified backend event system (SubjectType, EventAction, EventPhase, EventName).
// `EventName` from unified.js is the dotted automation-pattern type
// (`{subject}.{action}.{phase}`) — orthogonal to the colon-delimited realtime
// {@link EventName} declared above. Consumers needing the unified one should
// import it directly from `@synap-core/types/events/unified`.
export {
  SUBJECT_TYPES,
  OBSERVATION_NAMESPACES,
  EVENT_ACTIONS,
  EVENT_PHASES,
  buildEventName,
  subjectTrigger,
  validateEventPattern,
  parseEventPattern,
  parseRecordChange,
} from "./unified.js";
export type {
  SubjectType,
  EventAction,
  EventPhase,
  EventPattern,
} from "./unified.js";
// Connection lifecycle events → one human line (the non-CRUD half of the log).
export { parseConnectionEvent } from "./connection-lines.js";
export type { ConnectionEventLine } from "./connection-lines.js";
// Re-exported under an alias to avoid clashing with the realtime EventName.
export type { EventName as UnifiedEventName } from "./unified.js";
