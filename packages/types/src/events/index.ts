/**
 * Domain Event Types
 *
 * Type definitions for Socket.IO domain events.
 * These are emitted by Inngest workers via the realtime bridge
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
 * All domain event names for type checking
 */
export const DomainEventNames = {
  ENTITY_CREATED: "entity:created",
  ENTITY_UPDATED: "entity:updated",
  ENTITY_DELETED: "entity:deleted",
  DOCUMENT_UPDATED: "document:updated",
  DOCUMENT_VERSION: "document:version",
  AI_PROPOSAL: "ai:proposal",
  AI_PROPOSAL_STATUS: "ai:proposal:status",
  CHAT_MESSAGE: "chat:message",
  CHAT_STREAM: "chat:stream",
} as const;

export type DomainEventName =
  (typeof DomainEventNames)[keyof typeof DomainEventNames];

// Unified backend event system (SubjectType, EventAction, EventPhase, EventName)
export * from "./unified.js";
