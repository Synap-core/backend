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

/** Platforms that OpenClaw bridges into Synap channels. */
export type OpenClawPlatform =
  | "telegram"
  | "whatsapp"
  | "signal"
  | "matrix"
  | "discord"
  | "voice";

/** External chat platform message ingested via OpenClaw → routed into a Synap channel. */
export interface OpenClawMessageReceivedEvent {
  channelId: string;
  messageId: string;
  platform: OpenClawPlatform;
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

/** Hermes background-task lifecycle. `taskId` matches the background_tasks row id. */
export interface HermesTaskQueuedEvent {
  taskId: string;
  /** Task kind (job-queue name / task-template id). */
  kind: string;
  /** What initiated the task — "user", "agent:<type>", "automation", "cron", etc. */
  source: string;
  queuedAt: string;
}

export interface HermesTaskStartedEvent {
  taskId: string;
  kind: string;
  startedAt: string;
}

export interface HermesTaskCompletedEvent {
  taskId: string;
  /** Wall-clock duration in milliseconds (queued → completed). */
  durationMs: number;
  completedAt: string;
}

export interface HermesTaskFailedEvent {
  taskId: string;
  /** Human-readable error summary. Stack traces stay in logs. */
  error: string;
  failedAt: string;
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
  "openclaw:message:received": (data: OpenClawMessageReceivedEvent) => void;
  "synap:reply:routed": (data: SynapReplyRoutedEvent) => void;
  "hermes:task:queued": (data: HermesTaskQueuedEvent) => void;
  "hermes:task:started": (data: HermesTaskStartedEvent) => void;
  "hermes:task:completed": (data: HermesTaskCompletedEvent) => void;
  "hermes:task:failed": (data: HermesTaskFailedEvent) => void;

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
 * - `openclaw` — messaging ingress (external chat → Synap)
 * - `hermes` — execution daemon
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
  OPENCLAW_MESSAGE_RECEIVED: "openclaw:message:received",
  SYNAP_REPLY_ROUTED: "synap:reply:routed",
  HERMES_TASK_QUEUED: "hermes:task:queued",
  HERMES_TASK_STARTED: "hermes:task:started",
  HERMES_TASK_COMPLETED: "hermes:task:completed",
  HERMES_TASK_FAILED: "hermes:task:failed",
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];

/**
 * Maps an event name to its payload shape via {@link DomainServerToClientEvents}.
 * Lets `emitTyped<E>` infer the right payload from the event name alone, so
 * `emitTyped("hermes:task:queued", { ... })` is type-checked at the call site.
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
  EVENT_ACTIONS,
  EVENT_PHASES,
  buildEventName,
  subjectTrigger,
  validateEventPattern,
  parseEventPattern,
} from "./unified.js";
export type {
  SubjectType,
  EventAction,
  EventPhase,
  EventPattern,
} from "./unified.js";
// Re-exported under an alias to avoid clashing with the realtime EventName.
export type { EventName as UnifiedEventName } from "./unified.js";
