/**
 * Relation Types
 *
 * The row is declared in ./rows.js; @synap/database proves its inferred row
 * equal (packages/database/src/wire-parity/relations.ts).
 */

export type { Relation, NewRelation } from "./rows.js";

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
