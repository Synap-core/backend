/**
 * Database Package - Main Export
 * Pure PostgreSQL with postgres.js
 */

// Export PostgreSQL clients
export { sql, db, getDb } from "./client-pg.js";

// Export RLS functions
export {
  setCurrentUser,
  clearCurrentUser,
  closeDatabase,
} from "./client-pg.js";

// Export all schemas
export * from "./schema/index.js";

// Export all repositories
export * from "./repositories/index.js";

// Export services
export * from "./services/profile-resolution-service.js";
export * from "./services/property-validation-service.js";
export * from "./services/property-index-service.js";
export * from "./services/view-filter-compiler.js";
export * from "./services/property-merging-service.js";
export * from "./services/view-default-columns-service.js";
export * from "./services/encryption-service.js";
export * from "./services/entity-upsert-service.js";
export * from "./services/trusted-issuer-service.js";
export * from "./services/user-provisioning.js";

// Export errors
export * from "./errors/index.js";

// Utilities
export * from "./utils/preferences.js";
export * from "./utils/document-version-storage.js";
export * from "./utils/entity-project-membership.js";
export * from "./utils/materialize-entity.js";
export * from "./utils/stamp-provenance.js";
export * from "./utils/package-definition.js";
export * from "./utils/message-hash.js";
export * from "./utils/persist-assistant-reply.js";
export * from "./utils/open-run-session.js";
export * from "./utils/insert-pending-proposal.js";

// Server-side vault encryption
export {
  encryptServerSide,
  decryptServerSide,
  encryptConfig,
  decryptConfig,
  isServerVaultAvailable,
  type ServerEncryptedBlob,
} from "./utils/server-vault.js";

// Vault reference resolver
export {
  isVaultReference,
  parseVaultReference,
  resolveVaultSecret,
  resolveVaultReferences,
  getServiceSecret,
  upsertServiceSecret,
  findRedeemableGrant,
  findCapabilityGrant,
  resolveCapabilityGrant,
  incrementGrant,
  VaultGrantError,
  assertGrantScoped,
  UnscopedVaultGrantError,
} from "./utils/vault-resolver.js";
export type { GrantDenialCode, GrantRedeemer } from "./utils/vault-resolver.js";

// Discord REST + the generic Synap→Discord channel mirror (forward half).
// Placed in @synap/database so both @synap/api and @synap/jobs producers reach it.
export { mirrorMessageToBoundExternal } from "./utils/mirror-to-external.js";
export type {
  MirrorChannelRef,
  MirrorMessageParams,
  MirrorResult,
} from "./utils/mirror-to-external.js";
export { insertChannelMessage } from "./utils/insert-channel-message.js";
export type {
  InsertChannelMessageParams,
  InsertChannelMessageResult,
} from "./utils/insert-channel-message.js";
export { ensureExternalChannel } from "./utils/ensure-external-channel.js";
export type { EnsureExternalChannelArgs } from "./utils/ensure-external-channel.js";
export {
  setChannelBranchPurpose,
  ChannelFirewallImmutableError,
} from "./utils/set-channel-branch-purpose.js";
export { enqueueChannelEgress } from "./utils/channel-egress.js";
export type {
  ChannelEgressKind,
  EnqueueChannelEgressInput,
} from "./utils/channel-egress.js";

// Schema coherence tripwire — pod-startup guard against schema drift
export {
  validateSchemaCoherence,
  checkSchemaCoherence,
  type SchemaCoherenceResult,
} from "./utils/schema-coherence.js";
export {
  encryptServiceKey,
  decryptServiceKey,
  resolveServiceKey,
  isEncryptedServiceKey,
} from "./utils/service-key-crypto.js";
export {
  resolveDefaultIntelligenceEndpoint,
  type IntelligenceEndpoint,
} from "./utils/default-intelligence-endpoint.js";
// Explicit export for ensureDefaultWhiteboard to ensure TypeScript picks it up
export {
  ensureDefaultWhiteboard,
  type CreateDefaultWhiteboardResult,
} from "./utils/create-default-whiteboard.js";

// Export ensureSystemProfiles utility
export {
  ensureSystemProfiles,
  ensureDevplaneProfiles,
  type EnsureSystemProfilesResult,
} from "./utils/ensure-system-profiles.js";

// DEPRECATED: ensureDefaultViews is no longer auto-called. The frontend
// renders views ephemerally from profile data and persists them only when
// explicitly saved. The ensure-default-views.ts module is kept for reference
// but is no longer exported or called automatically.
//
// export {
//   ensureDefaultViews,
//   type EnsureDefaultViewsResult,
// } from "./utils/ensure-default-views.js";

// Export ensureDefaultCommands utility
export {
  ensureDefaultCommands,
  type EnsureDefaultCommandsResult,
} from "./utils/ensure-default-commands.js";

// Export ensureDefaultRelationDefs utility
export {
  ensureDefaultRelationDefs,
  type EnsureDefaultRelationDefsResult,
} from "./utils/ensure-default-relation-defs.js";

// Export seed property↔relation mappings utility
export {
  seedPropertyRelationMappings,
  type SeedMappingsResult,
} from "./utils/seed-property-relation-mappings.js";

// Export default relation defs constants
export {
  DEFAULT_RELATION_DEFS,
  SYSTEM_RELATION_TYPES,
  type DefaultRelationDef,
} from "./utils/default-relation-defs.js";

// Export createWorkspaceFromDefinition utility
export {
  createWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
  type CreateFromDefinitionOptions,
  type CreateFromDefinitionResult,
  type ResumeState,
} from "./utils/create-workspace-from-definition.js";
export {
  reconcileWorkspaceFromDefinition,
  type ReconcileOptions,
  type ReconcileReport,
} from "./utils/reconcile-workspace-from-definition.js";

// Export workspace definitions (built-in presets for createWorkspaceFromDefinition)
export { DEVOPS_DEFINITION } from "./definitions/devops-definition.js";

// Export document types for type safety
export type { DocumentType, DocumentMetadata } from "./types/document-types.js";
export {
  isDocumentType,
  normalizeDocumentType,
} from "./types/document-types.js";

// Database client
export * from "./client.js";
export type { EventHook } from "./repositories/event-repository.js";
export type {
  VectorSearchParams,
  VectorSearchRow,
  VectorRepositoryDatabase,
} from "./repositories/vector-repository.js";
export { searchEntityVectorsRaw } from "./repositories/vector-repository.js";

// Export projectors (event handlers for materialized views)
export * from "./projectors/index.js";

// Export new multi-level permission system
export * from "./utils/permissions.js";
export * from "./utils/preferences.js";

// Export sync materializer (shared between API receive + pull worker)
export {
  materializeBatch,
  materializeEvent,
  storeReceivedEvents,
  syncEventSchema,
  syncReceiveInputSchema,
  type SyncEvent,
  type MaterializeOptions,
} from "./utils/sync-materializer.js";

export {
  advanceOutboundSyncCursorAfterPushSuccess,
  type AdvanceOutboundSyncCursorParams,
} from "./utils/sync-outbound-cursor.js";

// Re-export commonly used drizzle-orm functions
export {
  // Query builders
  eq,
  and,
  or,
  not,
  sql as sqlTemplate, // Drizzle sql template tag
  // Comparison operators
  isNull,
  isNotNull,
  gt,
  gte,
  lt,
  lte,
  ne,
  // Subquery operators
  exists,
  // Array operators
  inArray,
  notInArray,
  arrayContains,
  // String operators
  like,
  notLike,
  ilike,
  notIlike,
  // Aggregation
  count,
  sum,
  avg,
  min,
  max,
  // Sorting
  asc,
  desc,
  // pgvector distance functions
  cosineDistance,
  l2Distance,
  innerProduct,
  // Types
  type SQL,
  type Column,
  getTableColumns,
} from "drizzle-orm";

// Also export sql from drizzle-orm as drizzleSql for clarity (for SQL template literals)
export { sql as drizzleSql } from "drizzle-orm";

// Also export as sqlDrizzle for even more clarity
export { sql as sqlDrizzle } from "drizzle-orm";

// Export postgres type for repositories that need raw SQL
export { type Sql } from "postgres";
