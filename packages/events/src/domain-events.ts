/**
 * Domain Events - Type-Safe Event Definitions
 * 
 * This file defines all domain events in the system using TypeScript.
 * Each event is strongly typed with its subject type and data shape.
 * 
 * Benefits:
 * - Compile-time type checking
 * - Autocomplete in IDE
 * - Self-documenting event contracts
 * - Safe refactoring
 */

// ============================================================================
// BASE EVENT STRUCTURE
// ============================================================================

/**
 * Base event structure that all domain events extend
 */
export interface BaseEvent<
  TType extends string,
  TSubjectType extends string,
  TData extends Record<string, unknown>
> {
  /** Event type (e.g., 'inbox.item.received') */
  type: TType;
  /** The ID of the thing this event is about */
  subjectId: string;
  /** The type of subject (e.g., 'inbox_item') */
  subjectType: TSubjectType;
  /** Event payload data */
  data: TData;
}

// ============================================================================
// INBOX EVENTS
// ============================================================================

/**
 * Inbox item received from external source (N8N)
 */
export type InboxItemReceivedEvent = BaseEvent<
  'inbox.item.received',
  'inbox_item',
  {
    provider: string;
    externalId: string;
    type: string;
    title: string;
    preview?: string;
    timestamp: Date;
    deepLink?: string;
    rawData: Record<string, unknown>;
  }
>;

/**
 * Inbox item analyzed by intelligence service
 */
export type InboxItemAnalyzedEvent = BaseEvent<
  'inbox.item.analyzed',
  'inbox_item',
  {
    requestId: string;
    analysis: {
      priority?: 'urgent' | 'high' | 'normal' | 'low';
      tags?: string[];
      category?: string;
      summary?: string;
    };
  }
>;

/**
 * Inbox item status updated (read, archived, snoozed)
 */
export type InboxItemStatusUpdatedEvent = BaseEvent<
  'inbox.item.status.updated',
  'inbox_item',
  {
    oldStatus: 'unread' | 'read' | 'archived' | 'snoozed';
    newStatus: 'unread' | 'read' | 'archived' | 'snoozed';
    snoozedUntil?: Date;
  }
>;

// ============================================================================
// ENTITY EVENTS
// ============================================================================

/**
 * Entity creation requested
 */
export type EntityCreateRequestedEvent = BaseEvent<
  'entities.create.requested',
  'entity',
  {
    entityType: 'note' | 'task' | 'project' | 'contact' | 'meeting' | 'idea' | 'event' | 'habit' | 'page';
    title?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }
>;

/**
 * Entity creation completed
 */
export type EntityCreateCompletedEvent = BaseEvent<
  'entities.create.completed',
  'entity',
  {
    entityType: 'note' | 'task' | 'project' | 'contact' | 'meeting' | 'idea' | 'event' | 'habit' | 'page';
    title?: string;
    fileUrl?: string;
    filePath?: string;
  }
>;

/**
 * Entity updated
 */
export type EntityUpdateRequestedEvent = BaseEvent<
  'entities.update.requested',
  'entity',
  {
    updates: {
      title?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    };
  }
>;

// ============================================================================
// DOCUMENT EVENTS
// ============================================================================

/**
 * Document creation requested
 */
export type DocumentCreateRequestedEvent = BaseEvent<
  'documents.create.requested',
  'document',
  {
    title: string;
    type: 'text' | 'markdown' | 'code' | 'pdf' | 'docx';
    content?: string;
    language?: string;
    projectId?: string;
  }
>;

/**
 * Document creation completed
 */
export type DocumentCreateCompletedEvent = BaseEvent<
  'documents.create.completed',
  'document',
  {
    title: string;
    storageUrl: string;
    storageKey: string;
    size: number;
    currentVersion: number;
  }
>;

// ============================================================================
// MESSAGE EVENTS
// ============================================================================

/**
 * Chat message created
 */
export type MessageCreateRequestedEvent = BaseEvent<
  'conversationMessages.create.requested',
  'message',
  {
    threadId: string;
    content: string;
    role: 'user' | 'assistant' | 'system';
    parentId?: string;
  }
>;

// ============================================================================
// CHAT THREAD EVENTS
// ============================================================================

/**
 * Chat thread created
 */
export type ChatThreadCreateRequestedEvent = BaseEvent<
  'chatThreads.create.requested',
  'chat_thread',
  {
    title?: string;
    threadType?: 'main' | 'branch';
    parentThreadId?: string;
    projectId?: string;
    agentId?: string;
  }
>;

// ============================================================================
// DOMAIN EVENT UNION
// ============================================================================

/**
 * Union type of all domain events in the system
 * 
 * Use this for type-safe event handlers and publishers
 */
export type DomainEvent =
  // Inbox events
  | InboxItemReceivedEvent
  | InboxItemAnalyzedEvent
  | InboxItemStatusUpdatedEvent
  // Entity events
  | EntityCreateRequestedEvent
  | EntityCreateCompletedEvent
  | EntityUpdateRequestedEvent
  // Document events
  | DocumentCreateRequestedEvent
  | DocumentCreateCompletedEvent
  // Message events
  | MessageCreateRequestedEvent
  // Chat thread events
  | ChatThreadCreateRequestedEvent;

// ============================================================================
// TYPE HELPERS
// ============================================================================

/**
 * Extract all possible event type strings
 */
export type EventType = DomainEvent['type'];

/**
 * Extract all possible subject type strings
 */
export type SubjectType = DomainEvent['subjectType'];

/**
 * Get the data type for a specific event type
 * 
 * Example: EventDataFor<'inbox.item.received'> returns the inbox item data type
 */
export type EventDataFor<T extends EventType> = Extract<
  DomainEvent,
  { type: T }
>['data'];

/**
 * Get the subject type for a specific event type
 */
export type SubjectTypeFor<T extends EventType> = Extract<
  DomainEvent,
  { type: T }
>['subjectType'];

/**
 * Get all events for a specific subject type
 */
export type EventsForSubject<T extends SubjectType> = Extract<
  DomainEvent,
  { subjectType: T }
>;
