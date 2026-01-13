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
  TData extends Record<string, unknown>,
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
  "inbox.item.received",
  "inbox_item",
  {
    provider: string;
    account: string; // ✅ Email/account identifier
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
  "inbox.item.analyzed",
  "inbox_item",
  {
    requestId: string;
    analysis: {
      priority?: "urgent" | "high" | "normal" | "low";
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
  "inbox.item.status.updated",
  "inbox_item",
  {
    oldStatus: "unread" | "read" | "archived" | "snoozed";
    newStatus: "unread" | "read" | "archived" | "snoozed";
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
  "entities.create.requested",
  "entity",
  {
    entityType:
      | "note"
      | "task"
      | "project"
      | "contact"
      | "meeting"
      | "idea"
      | "event"
      | "habit"
      | "page";
    title?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }
>;

/**
 * Entity creation completed
 */
export type EntityCreateCompletedEvent = BaseEvent<
  "entities.create.completed",
  "entity",
  {
    entityType:
      | "note"
      | "task"
      | "project"
      | "contact"
      | "meeting"
      | "idea"
      | "event"
      | "habit"
      | "page";
    title?: string;
    fileUrl?: string;
    filePath?: string;
  }
>;

/**
 * Entity updated
 */
export type EntityUpdateRequestedEvent = BaseEvent<
  "entities.update.requested",
  "entity",
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
  "documents.create.requested",
  "document",
  {
    title: string;
    type: "text" | "markdown" | "code" | "pdf" | "docx";
    content?: string;
    language?: string;
    projectId?: string;
  }
>;

/**
 * Document creation completed
 */
export type DocumentCreateCompletedEvent = BaseEvent<
  "documents.create.completed",
  "document",
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
  "conversationMessages.create.requested",
  "message",
  {
    threadId: string;
    content: string;
    role: "user" | "assistant" | "system";
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
  "chatThreads.create.requested",
  "chat_thread",
  {
    title?: string;
    threadType?: "main" | "branch";
    parentThreadId?: string;
    projectId?: string;
    agentId?: string;
  }
>;

// ============================================================================
// WORKSPACE EVENTS (V3.0)
// ============================================================================

/**
 * Workspace creation requested
 */
export type WorkspaceCreateRequestedEvent = BaseEvent<
  "workspaces.create.requested",
  "workspace",
  {
    name: string;
    type: "personal" | "team" | "enterprise";
    description?: string;
  }
>;

/**
 * Workspace creation validated
 */
export type WorkspaceCreateValidatedEvent = BaseEvent<
  "workspaces.create.validated",
  "workspace",
  {
    id: string;
    name: string;
    type: "personal" | "team" | "enterprise";
    ownerId: string;
  }
>;

/**
 * Workspace updated
 */
export type WorkspaceUpdateRequestedEvent = BaseEvent<
  "workspaces.update.requested",
  "workspace",
  {
    updates: {
      name?: string;
      description?: string;
      settings?: Record<string, unknown>;
    };
  }
>;

export type WorkspaceUpdateValidatedEvent = BaseEvent<
  "workspaces.update.validated",
  "workspace",
  {
    id: string;
    changes: Record<string, unknown>;
  }
>;

/**
 * Workspace member invited
 */
export type WorkspaceMemberCreateRequestedEvent = BaseEvent<
  "workspaceMembers.create.requested",
  "workspace_member",
  {
    workspaceId: string;
    email: string;
    role: "owner" | "admin" | "editor" | "viewer";
  }
>;

export type WorkspaceMemberCreateValidatedEvent = BaseEvent<
  "workspaceMembers.create.validated",
  "workspace_member",
  {
    id: string;
    workspaceId: string;
    userId: string;
    role: string;
  }
>;

// ============================================================================
// VIEW EVENTS (V3.0)
// ============================================================================

/**
 * View creation requested
 */
export type ViewCreateRequestedEvent = BaseEvent<
  "views.create.requested",
  "view",
  {
    type: "whiteboard" | "timeline" | "kanban" | "table";
    name: string;
    workspaceId: string;
  }
>;

export type ViewCreateValidatedEvent = BaseEvent<
  "views.create.validated",
  "view",
  {
    id: string;
    type: string;
    name: string;
    documentId: string;
  }
>;

/**
 * View updated (manual save only)
 */
export type ViewUpdateRequestedEvent = BaseEvent<
  "views.update.requested",
  "view",
  {
    saveType: "manual" | "publish";
  }
>;

export type ViewUpdateValidatedEvent = BaseEvent<
  "views.update.validated",
  "view",
  {
    id: string;
    versionNumber: number;
    savedAt: Date;
  }
>;

// ============================================================================
// USER PREFERENCES EVENTS (V3.0)
// ============================================================================

/**
 * User preferences updated
 */
export type UserPreferencesUpdateRequestedEvent = BaseEvent<
  "userPreferences.update.requested",
  "user_preferences",
  {
    changes: {
      theme?: "light" | "dark" | "system";
      uiPreferences?: Record<string, unknown>;
      graphPreferences?: Record<string, unknown>;
    };
  }
>;

export type UserPreferencesUpdateValidatedEvent = BaseEvent<
  "userPreferences.update.validated",
  "user_preferences",
  {
    userId: string;
    changes: Record<string, unknown>;
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
  | ChatThreadCreateRequestedEvent
  // Workspace events (V3.0)
  | WorkspaceCreateRequestedEvent
  | WorkspaceCreateValidatedEvent
  | WorkspaceUpdateRequestedEvent
  | WorkspaceUpdateValidatedEvent
  | WorkspaceMemberCreateRequestedEvent
  | WorkspaceMemberCreateValidatedEvent
  // View events (V3.0)
  | ViewCreateRequestedEvent
  | ViewCreateValidatedEvent
  | ViewUpdateRequestedEvent
  | ViewUpdateValidatedEvent
  // User preferences events (V3.0)
  | UserPreferencesUpdateRequestedEvent
  | UserPreferencesUpdateValidatedEvent;

// ============================================================================
// TYPE HELPERS
// ============================================================================

/**
 * Extract all possible event type strings
 */
export type EventType = DomainEvent["type"];

/**
 * Extract all possible subject type strings
 */
export type SubjectType = DomainEvent["subjectType"];

/**
 * Get the data type for a specific event type
 *
 * Example: EventDataFor<'inbox.item.received'> returns the inbox item data type
 */
export type EventDataFor<T extends EventType> = Extract<
  DomainEvent,
  { type: T }
>["data"];

/**
 * Get the subject type for a specific event type
 */
export type SubjectTypeFor<T extends EventType> = Extract<
  DomainEvent,
  { type: T }
>["subjectType"];

/**
 * Get all events for a specific subject type
 */
export type EventsForSubject<T extends SubjectType> = Extract<
  DomainEvent,
  { subjectType: T }
>;
