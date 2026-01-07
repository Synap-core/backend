/**
 * Domain Event Types
 * 
 * Type definitions for Socket.IO domain events.
 * These are emitted by Inngest workers via the realtime bridge
 * to notify clients about data changes.
 * 
 * SINGLE SOURCE OF TRUTH - Frontend imports from here.
 */

import type { Entity } from '../index.js';

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
  proposalId: string;
  workspaceId: string;
  targetType: 'entity' | 'document';
  targetId?: string;
  operation: 'create' | 'update' | 'delete';
  data: unknown;
  reasoning: string;
  confidence: number;
  createdAt: string;
}

export interface AIProposalStatusEvent {
  proposalId: string;
  workspaceId: string;
  status: 'approved' | 'rejected';
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
  role: 'user' | 'assistant';
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
  'entity:created': (data: EntityCreatedEvent) => void;
  'entity:updated': (data: EntityUpdatedEvent) => void;
  'entity:deleted': (data: EntityDeletedEvent) => void;
  
  // Documents
  'document:updated': (data: DocumentUpdatedEvent) => void;
  'document:version': (data: DocumentVersionCreatedEvent) => void;
  
  // AI
  'ai:proposal': (data: AIProposalEvent) => void;
  'ai:proposal:status': (data: AIProposalStatusEvent) => void;
  
  // Chat
  'chat:message': (data: ChatMessageEvent) => void;
  'chat:stream': (data: ChatStreamEvent) => void;
  
  // System
  'error': (data: { code: string; message: string }) => void;
}

// =============================================================================
// Client to Server Events Map
// =============================================================================

/**
 * Events clients can send to server.
 */
export interface DomainClientToServerEvents {
  // Room management
  'join-workspace': (workspaceId: string) => void;
  'leave-workspace': (workspaceId: string) => void;
  'join-document': (documentId: string) => void;
  'leave-document': (documentId: string) => void;
}

// =============================================================================
// Event Names
// =============================================================================

/**
 * All domain event names for type checking
 */
export const DomainEventNames = {
  ENTITY_CREATED: 'entity:created',
  ENTITY_UPDATED: 'entity:updated',
  ENTITY_DELETED: 'entity:deleted',
  DOCUMENT_UPDATED: 'document:updated',
  DOCUMENT_VERSION: 'document:version',
  AI_PROPOSAL: 'ai:proposal',
  AI_PROPOSAL_STATUS: 'ai:proposal:status',
  CHAT_MESSAGE: 'chat:message',
  CHAT_STREAM: 'chat:stream',
} as const;

export type DomainEventName = typeof DomainEventNames[keyof typeof DomainEventNames];
