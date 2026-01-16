/**
 * Router Types
 *
 * Type definitions for API router responses and internal data structures.
 * These types improve type safety in routers that currently use 'any'.
 *
 * Note: Hub Protocol types (HubResponse, AIStep, etc.) are imported from hub-protocol/index.ts
 */

// Re-export Hub Protocol types for convenience
export type {
  HubResponse,
  HubStreamEvent,
  ExtractedEntity,
  BranchDecision,
  TokenUsage,
  AIStep,
  HubContext,
  HubRequest,
} from "./hub-protocol/index.js";

/**
 * Database Row Types (for Hub Protocol transforms)
 */

export interface HubEntityRow {
  id: string;
  title: string;
  type: string;
  description: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  user_id: string;
  workspace_id: string | null;
  project_id: string | null;
}

export interface HubDocumentRow {
  id: string;
  title: string;
  content: string;
  format: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  entity_id: string | null;
}

export interface HubMessageRow {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Search & Query Types
 */

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  description: string | null;
  similarity?: number;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  similarity: number;
  entity: {
    id: string;
    type: string;
    title: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
  };
  distance?: number;
}

/**
 * Tag & Entity Relationship Types
 */

export interface EntityTag {
  tag: {
    id: string;
    name: string;
    color?: string;
    userId: string;
  } | null;
  entity: {
    id: string;
    type: string;
    title: string;
    userId: string;
    deletedAt?: Date | null;
  } | null;
  created_at?: Date;
}

export interface EntityRelation {
  source_id: string;
  target_id: string;
  relation_type: string;
  metadata?: Record<string, unknown>;
}

/**
 * Graph & Knowledge Types
 */

export interface RelatedEntity {
  id: string;
  type: string;
  title: string;
  relationshipType: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  properties?: Record<string, unknown>;
}

/**
 * Content & Document Types
 */

export interface ContentResult {
  id: string;
  type: string;
  title: string;
  content?: string;
  format?: string;
  metadata?: Record<string, unknown>;
  created_at?: Date;
  updated_at?: Date;
}

export interface DocumentContent {
  id: string;
  content: string;
  format: "markdown" | "html" | "text" | "json";
  metadata: Record<string, unknown>;
}

/**
 * System & Admin Types
 */

export interface TableInfo {
  table_name: string;
  table_schema: string;
  table_type: string;
  row_count?: number;
}

export interface DatabaseStats {
  total_events: number;
  total_entities: number;
  total_documents: number;
  total_messages: number;
  storage_size: string;
}

/**
 * Pagination & Filtering Types
 */

export interface PaginationParams {
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    nextCursor?: string;
  };
}

export interface FilterParams {
  type?: string;
  status?: string;
  userId?: string;
  workspaceId?: string;
  projectId?: string;
  tags?: string[];
  dateFrom?: Date;
  dateTo?: Date;
}

/**
 * Utility Types
 */

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<
  T,
  Exclude<keyof T, Keys>
> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type Maybe<T> = T | null | undefined;
