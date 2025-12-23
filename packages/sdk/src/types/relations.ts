/**
 * Relation Types
 */

export type RelationType =
  | 'assigned_to'    // Task → Person
  | 'mentions'       // Note → Person/Entity
  | 'links_to'       // Note → Note
  | 'parent_of'      // Project → Task
  | 'relates_to'     // Generic relation
  | 'tagged_with'    // Entity → Tag
  | 'created_by'     // Entity → Person
  | 'attended_by'    // Event → Person
  | 'depends_on'     // Task → Task
  | 'blocks';        // Task → Task

export interface Relation {
  id: string;
  userId: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: RelationType | string;
  createdAt: Date;
}

export interface NewRelation {
  id?: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: RelationType | string;
  metadata?: Record<string, unknown>;
}

export interface RelationFilter {
  entityId: string;
  type?: RelationType | string;
  direction?: 'source' | 'target' | 'both';
  limit?: number;
}
