/**
 * Compile-time contract: the per-user rows `@synap-core/types/users` declares
 * are EXACTLY the rows inferred from this package's tables
 * (`schema/user-resource-state.ts`, `schema/user-entity-state.ts`,
 * `schema/enrichments.ts`). No runtime code. A column added, retyped or made
 * nullable on one side only fails `tsc` here.
 */
import type * as Wire from "@synap-core/types/users";
import type {
  UserResourceState,
  NewUserResourceState,
  UserResourceType,
  ResourceSemanticSize,
} from "../schema/user-resource-state.js";
import type {
  UserEntityState,
  NewUserEntityState,
} from "../schema/user-entity-state.js";
import type {
  EntityEnrichment,
  NewEntityEnrichment,
  EntityRelationship,
  NewEntityRelationship,
  ReasoningTrace,
  NewReasoningTrace,
} from "../schema/enrichments.js";
import type { Equal, Flat } from "./equal.js";

export const _resourceType: Equal<UserResourceType, Wire.UserResourceType> =
  true;
export const _semanticSize: Equal<
  ResourceSemanticSize,
  Wire.ResourceSemanticSize
> = true;
export const _resourceState: Equal<UserResourceState, Wire.UserResourceState> =
  true;
export const _newResourceState: Equal<
  NewUserResourceState,
  Wire.NewUserResourceState
> = true;
// `UserEntityState` is an `Omit<…> & {…}` on this side: flattened to compare.
export const _entityState: Equal<
  Flat<UserEntityState>,
  Wire.UserEntityState
> = true;
export const _newEntityState: Equal<
  Flat<NewUserEntityState>,
  Wire.NewUserEntityState
> = true;
export const _enrichment: Equal<EntityEnrichment, Wire.EntityEnrichment> = true;
export const _newEnrichment: Equal<
  NewEntityEnrichment,
  Wire.NewEntityEnrichment
> = true;
export const _relationship: Equal<EntityRelationship, Wire.EntityRelationship> =
  true;
export const _newRelationship: Equal<
  NewEntityRelationship,
  Wire.NewEntityRelationship
> = true;
export const _reasoningTrace: Equal<ReasoningTrace, Wire.ReasoningTrace> = true;
export const _newReasoningTrace: Equal<
  NewReasoningTrace,
  Wire.NewReasoningTrace
> = true;
