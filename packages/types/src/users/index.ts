/**
 * User Types
 *
 * Per-user rows, declared in ./rows.js; @synap/database proves its inferred
 * rows equal (packages/database/src/wire-parity/users.ts).
 */

export type {
  UserResourceState,
  NewUserResourceState,
  UserResourceType,
  ResourceSemanticSize,
  UserEntityState,
  NewUserEntityState,
  EntityEnrichment,
  NewEntityEnrichment,
  EntityRelationship,
  NewEntityRelationship,
  ReasoningTrace,
  NewReasoningTrace,
} from "./rows.js";
