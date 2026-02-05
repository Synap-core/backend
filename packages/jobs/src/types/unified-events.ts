/**
 * Unified Event Types
 *
 * Generic event type system that works for ALL entities.
 * Pattern: {subjectType}.{action}.{phase}
 *
 * Examples:
 * - "entities.create.requested"
 * - "documents.update.validated"
 * - "workspaces.delete.completed"
 */

import { randomUUID } from "crypto";
import type { EnhancedEventMetadata } from "@synap-core/core";

// ============================================================================
// EVENT PHASES & ACTIONS
// ============================================================================

/**
 * Event Phases
 */
export type EventPhase = "requested" | "validated" | "completed" | "denied";

/**
 * Event Actions
 */
export type EventAction =
  | "create"
  | "update"
  | "delete"
  | "archive"
  | "restore";

/**
 * Subject Types (all entity types in the system)
 */
export type SubjectType =
  | "entity"
  | "document"
  | "workspace"
  | "view"
  | "relation"
  | "tag"
  | "project"
  | "proposal"
  | "message"
  | "user"
  | "role"
  | "apiKey"
  | "skill"
  | "backgroundTask"
  | "agent"
  | "chatThread"
  | "template"
  | "inboxItem"
  | "sharing";

// ============================================================================
// GENERIC EVENT TYPE GENERATOR
// ============================================================================

/**
 * Generic Event Type Generator
 *
 * Creates type-safe event types for any subject type and action.
 * This ensures consistency across all entities.
 */
export type GenericEventType<
  TSubjectType extends string,
  TAction extends EventAction,
  TPhase extends EventPhase,
> = `${TSubjectType}.${TAction}.${TPhase}`;

// Examples:
// GenericEventType<"entities", "create", "requested"> = "entities.create.requested"
// GenericEventType<"documents", "update", "validated"> = "documents.update.validated"

// ============================================================================
// UNIFIED EVENT DATA STRUCTURE
// ============================================================================

/**
 * Unified Event Data Structure
 *
 * Works for ALL entities: entities, documents, workspaces, views, etc.
 * The structure is the same, only the subjectType changes.
 *
 * This is a base interface - all properties are optional and additional
 * properties can be added for entity-specific data.
 */
export interface UnifiedEventData {
  // Core Identity
  id?: string; // Entity ID (for create: generated, for update/delete: required)

  // Entity-Specific Data (flexible, but structured)
  // For CREATE:
  title?: string;
  content?: string;
  type?: string; // Entity type: "note", "task", "markdown", "whiteboard", etc.
  metadata?: Record<string, unknown>; // Entity-specific metadata

  // For UPDATE:
  changes?: Record<string, unknown>; // What changed
  previousVersion?: number;
  newVersion?: number;

  // For DELETE:
  cascade?: boolean; // Delete related entities?
  reason?: string; // Why deleted?

  // Common Fields (all operations)
  workspaceId?: string;
  // Projects: Removed projectIds (use relations table with type "belongs_to_project")
  tags?: string[];
  relations?: Array<{ targetId: string; type: string }>;

  // Links to Related Entities (for provenance)
  linkedTo?: {
    proposalId?: string; // If created from proposal
    messageId?: string; // If created from message
    threadId?: string; // If created in thread
    userId?: string; // If created by/for user
    agentId?: string; // If created by agent
    parentId?: string; // If created from parent entity
    sourceEventId?: string; // If created from another event
  };

  // Allow additional properties for entity-specific data
  [key: string]: unknown;
}

// ============================================================================
// UNIFIED EVENT TYPE
// ============================================================================

/**
 * Unified Event Type
 *
 * Works for ALL entities - same structure, different subjectType.
 */
export interface UnifiedEvent<
  TSubjectType extends string,
  TAction extends EventAction,
  TPhase extends EventPhase,
> {
  // Event Identity
  id: string; // Event ID (UUID)
  version: "v1";
  type: GenericEventType<TSubjectType, TAction, TPhase>;

  // Subject (what this event is about)
  subjectId: string; // Entity ID (UUID)
  subjectType: TSubjectType; // "entity" | "document" | "workspace" | ...

  // Event Data (unified structure)
  data: UnifiedEventData;

  // Enhanced Metadata (rich context)
  metadata?: EnhancedEventMetadata;

  // Ownership & Source
  userId: string; // Who triggered this
  source:
    | "api"
    | "automation"
    | "sync"
    | "migration"
    | "system"
    | "intelligence"
    | "iot"
    | "enterprise";
  timestamp: Date;

  // Tracing
  correlationId?: string; // Group related events
  causationId?: string; // Event that caused this
  requestId?: string; // API request ID

  // Inngest-specific (for executor handlers)
  user?: { id: string }; // Inngest user context
}

// ============================================================================
// TYPE-SAFE EVENT CREATOR
// ============================================================================

/**
 * Type-safe event creator for any entity
 */
export function createUnifiedEvent<
  TSubjectType extends string,
  TAction extends EventAction,
  TPhase extends EventPhase,
>(params: {
  subjectType: TSubjectType;
  action: TAction;
  phase: TPhase;
  subjectId?: string; // Optional for create.requested
  data: UnifiedEventData;
  metadata?: EnhancedEventMetadata;
  userId: string;
  source?: UnifiedEvent<TSubjectType, TAction, TPhase>["source"];
  correlationId?: string;
  causationId?: string;
  requestId?: string;
}): UnifiedEvent<TSubjectType, TAction, TPhase> {
  const type =
    `${params.subjectType}.${params.action}.${params.phase}` as GenericEventType<
      TSubjectType,
      TAction,
      TPhase
    >;

  return {
    id: randomUUID(),
    version: "v1",
    type,
    subjectId: params.subjectId || randomUUID(), // Generate if not provided
    subjectType: params.subjectType,
    data: params.data,
    metadata: params.metadata,
    userId: params.userId,
    source: params.source || "api",
    timestamp: new Date(),
    correlationId: params.correlationId,
    causationId: params.causationId,
    requestId: params.requestId,
  };
}

// ============================================================================
// EVENT TYPE EXTRACTION HELPERS
// ============================================================================

/**
 * Extract subject type, action, and phase from event type
 */
export function extractEventInfo(eventType: string): {
  subjectType: string;
  action: EventAction;
  phase: EventPhase;
} {
  const parts = eventType.split(".");
  if (parts.length !== 3) {
    throw new Error(
      `Invalid event type format: ${eventType}. Expected: {subjectType}.{action}.{phase}`
    );
  }

  const [subjectType, action, phase] = parts;

  if (!["create", "update", "delete", "archive", "restore"].includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }

  if (!["requested", "validated", "completed", "denied"].includes(phase)) {
    throw new Error(`Invalid phase: ${phase}`);
  }

  return {
    subjectType,
    action: action as EventAction,
    phase: phase as EventPhase,
  };
}

/**
 * Check if event type matches pattern
 */
export function isEventType(
  eventType: string,
  subjectType?: string,
  action?: EventAction,
  phase?: EventPhase
): boolean {
  const info = extractEventInfo(eventType);

  if (subjectType && info.subjectType !== subjectType) return false;
  if (action && info.action !== action) return false;
  if (phase && info.phase !== phase) return false;

  return true;
}
