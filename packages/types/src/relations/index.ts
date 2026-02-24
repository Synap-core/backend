/**
 * Relation Types
 *
 * Re-exports relation types from database schema (single source of truth).
 *
 * @see {@link @synap/database/schema}
 */

// Direct re-exports from database
export type { Relation, NewRelation } from "@synap/database";

/**
 * Built-in relation types. Workspace-defined custom types (from relation_defs)
 * are also valid — use `string` when accepting arbitrary relation types.
 */
export type BuiltInRelationType =
  | "assigned_to"
  | "mentions"
  | "links_to"
  | "parent_of"
  | "relates_to"
  | "tagged_with"
  | "created_by"
  | "attended_by"
  | "depends_on"
  | "blocks"
  | "belongs_to_project"
  | "embedded_in"
  | "visualized_in"
  | "references";

/** Built-in or workspace-defined custom relation type */
export type RelationType = BuiltInRelationType | (string & {});

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
