/**
 * User Types
 * 
 * Re-exports user-related types from database schema.
 * 
 * @see {@link @synap/database/schema}
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
