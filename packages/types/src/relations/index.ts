/**
 * Relation Types
 *
 * Re-exports relation types from database schema (single source of truth).
 *
 * @see {@link @synap/database/schema}
 */

// Direct re-exports from database
export type {
  Relation,
  NewRelation,
} from "../../../database/src/schema/index.js";

// Relation type definitions
export type RelationType =
  | "related_to" // Generic relationship
  | "parent_of" // Hierarchy (parent → child)
  | "child_of" // Inverse hierarchy (child → parent)
  | "blocks" // Dependencies (X blocks Y)
  | "mentioned_in" // Content references
  | "linked_to"; // User-created links

// Input types for API operations
export interface CreateRelationInput {
  sourceEntityId: string;
  targetEntityId: string;
  type: RelationType;
  metadata?: Record<string, unknown>;
}

export interface RelationWithEntities {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: RelationType;
  createdAt: Date;
  // Populated fields
  sourceEntity?: {
    id: string;
    title: string | null;
    type: string;
  };
  targetEntity?: {
    id: string;
    title: string | null;
    type: string;
  };
}
