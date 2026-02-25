/**
 * Relation Types
 *
 * Re-exports relation types from database schema (single source of truth).
 *
 * @see {@link @synap/database/schema}
 */

// Direct re-exports from database
export type { Relation, NewRelation } from "@synap/database";

/** Relation type — any string slug from workspace relation_defs */
export type RelationType = string;

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
  type: string;
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
