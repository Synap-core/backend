/**
 * Relation Types
 *
 * Re-exports relation types from database schema (single source of truth).
 *
 * @see {@link @synap/database/schema}
 */
export type {
  Relation,
  NewRelation,
} from "../../../database/src/schema/index.js";
export type RelationType =
  | "related_to"
  | "parent_of"
  | "child_of"
  | "blocks"
  | "mentioned_in"
  | "linked_to";
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
//# sourceMappingURL=index.d.ts.map
