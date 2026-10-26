/**
 * Per-user rows on the wire — resource state, enrichments, entity
 * relationships, reasoning traces — as the pod reads and inserts them.
 *
 * The pod's types are inferred from its drizzle tables; this package cannot see
 * those tables, so the wire shape is declared here and `@synap/database` proves
 * it equal to the inferred one (`src/wire-parity/users.ts`): a column added on
 * one side only fails the database build.
 */

export type UserResourceType = "entity" | "view" | "inbox_item";
export type ResourceSemanticSize = "small" | "medium" | "large";

// ── user_entity_state (resource vocabulary) ─────────────────────────────────

export interface UserResourceState {
  userId: string;
  resourceId: string;
  resourceType: UserResourceType;
  starred: boolean;
  pinned: boolean;
  semanticSize: ResourceSemanticSize | null;
  lastOpenedAt: Date | null;
  openCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewUserResourceState {
  userId: string;
  resourceId: string;
  resourceType: UserResourceType;
  starred?: boolean;
  pinned?: boolean;
  semanticSize?: ResourceSemanticSize | null;
  lastOpenedAt?: Date | null;
  openCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── user_entity_state (pre-resource-state field vocabulary) ─────────────────

export interface UserEntityState {
  userId: string;
  itemId: string;
  itemType: "entity" | "view" | "inbox_item";
  starred: boolean;
  pinned: boolean;
  semanticSize: ResourceSemanticSize | null;
  lastViewedAt: Date | null;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewUserEntityState {
  userId: string;
  itemId: string;
  itemType: "entity" | "view" | "inbox_item";
  starred?: boolean;
  pinned?: boolean;
  semanticSize?: ResourceSemanticSize | null;
  lastViewedAt?: Date | null;
  viewCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── entity_enrichments ──────────────────────────────────────────────────────

export type EntityEnrichmentType =
  "properties" | "extraction" | "classification" | "knowledge";

export interface EntityEnrichment {
  id: string;
  entityId: string;
  userId: string;
  enrichmentType: EntityEnrichmentType;
  data: unknown;
  sourceEventId: string;
  agentId: string;
  confidence: string;
  createdAt: Date;
}

export interface NewEntityEnrichment {
  id?: string;
  entityId: string;
  userId: string;
  enrichmentType: EntityEnrichmentType;
  data: unknown;
  sourceEventId: string;
  agentId: string;
  confidence: string;
  createdAt?: Date;
}

// ── entity_relationships ────────────────────────────────────────────────────

export type EntityRelationshipType =
  | "related_to"
  | "part_of"
  | "depends_on"
  | "mentioned_in"
  | "created_from"
  | "supersedes"
  | "similar_to"
  | "contradicts";

export interface EntityRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: EntityRelationshipType;
  context: string | null;
  userId: string;
  sourceEventId: string;
  agentId: string;
  confidence: string;
  createdAt: Date;
}

export interface NewEntityRelationship {
  id?: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: EntityRelationshipType;
  context?: string | null;
  userId: string;
  sourceEventId: string;
  agentId: string;
  confidence: string;
  createdAt?: Date;
}

// ── reasoning_traces ────────────────────────────────────────────────────────

export type ReasoningTraceSubjectType =
  "query" | "entity" | "message" | "thread" | "task";

export interface ReasoningTrace {
  id: string;
  userId: string;
  subjectType: ReasoningTraceSubjectType;
  subjectId: string;
  steps: unknown;
  outcome: unknown;
  metrics: unknown;
  sourceEventId: string;
  agentId: string;
  createdAt: Date;
}

export interface NewReasoningTrace {
  id?: string;
  userId: string;
  subjectType: ReasoningTraceSubjectType;
  subjectId: string;
  steps: unknown;
  outcome: unknown;
  metrics?: unknown;
  sourceEventId: string;
  agentId: string;
  createdAt?: Date;
}
