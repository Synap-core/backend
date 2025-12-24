/**
 * User Types
 * 
 * Re-exports user-related types from database and adds custom types.
 * 
 * @see {@link file:///.../packages/database/src/schema/user-entity-state.ts}
 * @see {@link file:///.../packages/database/src/schema/enrichments.ts}
 */

// Direct re-exports from database
export type { 
  UserEntityState,
  NewUserEntityState,
  EntityEnrichment,
  NewEntityEnrichment,
  EntityRelationship,
  NewEntityRelationship,
  ReasoningTrace,
  NewReasoningTrace,
} from '@synap/database/schema';
