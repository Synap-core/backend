/**
 * API Package - Main Export
 */

export * from "./trpc.js";
export {
  encryptServiceKey,
  resolveServiceKey,
} from "./utils/service-key-crypto.js";
export * from "./context.js";
export { eventsRouter } from "./routers/events.js";
export { captureRouter } from "./routers/capture.js";
export { chatRouter } from "./routers/chat.js";
export { suggestionsRouter } from "./routers/suggestions.js";
export { systemRouter } from "./routers/system.js";
export { hubRouter } from "./routers/hub.js";
export { hubProtocolRestApp } from "./routers/hub-protocol-rest.js";
export { AUTOMATION_SCHEMA } from "./routers/hub-protocol/rest/automation-schema-doc.js";
export { apiKeyService } from "./services/api-keys.js";
export { ImportOrchestrator } from "./services/import-orchestrator.js";
export { hubProtocolRouter } from "./routers/hub-protocol/index.js";
export { integrationsCapabilitiesApp } from "./routers/integrations-capabilities.js";
export { syncReceiveApp } from "./routers/sync.js";
export { webhooksInboundRouter } from "./routers/webhooks-inbound.js";
export { createHubProtocolCallerContext } from "./routers/hub-protocol/utils.js";
export { proposalsRouter } from "./routers/proposals.js";
export { resolveIntelligenceService } from "./utils/intelligence-routing.js";
export { getPodCallback, type PodCallback } from "./utils/pod-callback.js";
export {
  ensureAgentThread,
  ensureWorkspaceGroupChannel,
  ensureProactiveFeedChannel,
  getAgentIdBySlug,
} from "./utils/personal-channel.js";
export { mcpHttpApp } from "./routers/mcp/http-handler.js";
// Pod-as-OAuth-2.1-authorization-server (Path B): /.well-known/*, /register,
// /authorize, /token. Mounted at the pod root in apps/api/src/index.ts.
export { oauthApp } from "./routers/oauth/routes.js";
export {
  configuredPodAdminBase,
  configuredPodAdminConsentUrl,
  type PodAdminConfigResult,
} from "./utils/pod-admin-url.js";
export { fileUploadApp } from "./routers/file-upload.js";
export { externalSkillsApp } from "./routers/external/skills.js";
export { externalChatApp } from "./routers/external/chat.js";
export { chatStreamApp } from "./routers/chat-stream.js";
export { openaiCompatApp } from "./routers/external/openai-compat.js";
export { apiKeysRouter } from "./routers/api-keys.js";
export { ensureSynapCoreCapability } from "./services/capabilities/ensure-synap-core.js";
export { ensureSystemSkills } from "./services/capabilities/ensure-system-skills.js";
// Boot-seed the widget_definitions table from the @synap/capabilities manifest
// (idempotent upsert). Previously invoked via the now-deleted plugins/init.ts;
// re-homed onto the canonical startup-hooks path so it survives the registry KILL.
export { seedWidgetDefinitions } from "./lib/seed-widget-definitions.js";
export {
  ensureCaptureAgent,
  getCaptureAgentUserId,
} from "./services/capture-agent/ensure-capture-agent.js";
export {
  createCapabilityFromDefinition,
  loadCapabilityTemplate,
  type CreateCapabilityResult,
  type CapabilityDefinitionWithPlaybooks,
} from "./services/capabilities/create-from-definition.js";
export {
  capabilityDefinitionDrift,
  canonicalJson,
  type CapabilityDriftResult,
  type InstalledSkillRow,
  type DefinitionSkillRow,
} from "./services/capabilities/capability-drift.js";
export {
  reconcileCapabilitiesToTemplates,
  type CapabilityReconcileReport,
  type CapabilityReconcileEntry,
} from "./services/capabilities/reconcile-capabilities-to-templates.js";
export {
  notifyCapabilityUpdatesAvailable,
  CAPABILITY_UPDATE_GROUP_KEY,
} from "./services/capabilities/notify-capability-updates.js";
export {
  reconcileStandaloneConfigsToTemplates,
  detachStandaloneConfigSource,
  type StandaloneReconcileReport,
  type StandaloneReconcileEntry,
  type StandaloneKind,
  type DetachResult,
} from "./services/capabilities/reconcile-standalone-configs-to-templates.js";
export {
  orderWorkspacesByTemplateDependencies,
  type OrderableWorkspaceRow,
  type TemplateForOrdering,
  type TemplateDependencyRef,
  type TemplateLookup,
} from "./services/workspace-reconcile-order.js";
export {
  resolveWorkspaceTemplate,
  type ResolvedWorkspaceTemplate,
} from "./services/capabilities/resolve-workspace-template.js";
export { healthRouter } from "./routers/health.js";
export { projectsRouter } from "./routers/projects.js";
export { sourceConfigsRouter } from "./routers/source-configs.js";
export { adminSourceConfigsRouter } from "./routers/admin-source-configs.js";
export {
  DeliveryService,
  type DeliveryRequest,
  type DeliveryResult,
  type DeliverySurface,
  type DeliveryContent,
} from "./services/DeliveryService.js";
export {
  FeedConfigSchema,
  RSSFeedConfigSchema,
  ProactiveFeedConfigSchema,
  FeedStatusSchema,
  FeedExecutionPayloadSchema,
  FeedMessageMetadataSchema,
  parseFeedConfig,
  getDefaultRSSConfig,
  getDefaultProactiveConfig,
  type FeedConfig,
  type RSSFeedConfig,
  type ProactiveFeedConfig,
  type FeedStatus,
  type FeedExecutionPayload,
  type FeedMessageMetadata,
} from "./types/feed-config.js";

export {
  requireUserId,
  userScope,
  userScopeAnd,
  type EventDataWithUser,
} from "./utils/user-scoped.js";

// Export the 5xx error-egress sanitizer (the one door for what a server fault
// may tell a client — see middleware/error-egress.ts).
export { sanitizeErrorEgress } from "./middleware/error-egress.js";

// Export event streaming utilities
export { eventStreamManager } from "./event-stream-manager.js";
export { setupEventBroadcasting } from "./setup-event-broadcasting.js";

// Export CORS cache for dynamic origin management
export {
  getDynamicCorsOrigins,
  setDynamicCorsOrigins,
} from "./utils/cors-cache.js";

// Export utilities for webhook handling
export { syncUserFromKratos } from "./utils/kratos-sync.js";

// Export vault resolver utilities (used by ssh-proxy and other server-side consumers)
export {
  isVaultReference,
  parseVaultReference,
  resolveVaultSecret,
  resolveVaultReferences,
} from "./utils/vault-resolver.js";

// Export generic trusted-issuer JWT verification. CP-named aliases remain for
// older Pod routes while those routes migrate to the generic boundary.
export {
  verifyIssuerJwt,
  verifyTrustedIssuerJwt,
  verifyCpJwt,
  verifyCpJwtWithTrust,
  clearJwksCache,
} from "./utils/jwks-client.js";
export { normalizeIssuerUrl } from "./utils/issuer-url-safety.js";
export {
  fetchFederationMetadata,
  type FederationMetadata,
} from "./utils/federation-metadata-client.js";
export {
  APPLICATION_CONNECTION_SCOPES,
  normalizeApplicationClientId,
  normalizeApplicationOrigin,
  normalizeApplicationCallbackUrl,
  normalizePublisherUrl,
  normalizeApplicationConnectionScopes,
  hashOpaqueApplicationConnectionValue,
  createOpaqueApplicationConnectionValue,
  buildApplicationConnectionReturnUrl,
  type ApplicationConnectionScope,
} from "./utils/application-connection.js";
export {
  setTrustedIssuerSeedHealth,
  getTrustedIssuerSeedHealth,
} from "./utils/startup-health.js";

// Export split-brain detection service
export {
  getSyncGenerationState,
  getSyncGenerationRow,
  isPodReadOnly,
  promoteToPrimary,
  incrementGeneration,
  recordPeerGeneration,
  invalidateSyncGenerationCache,
} from "./utils/split-brain-service.js";

export {
  createAndVerifyHubInboundKey,
  toRegistrationTrace,
  type RegistrationOutcome,
  type RegistrationResult,
  type RegistrationTrace,
} from "./services/external-registration.js";

export { consumeLinkToken } from "./utils/consume-link-token.js";

// Export utilities for default whiteboard creation
// Re-export ensureDefaultWhiteboard from @synap/database for convenience
export { ensureDefaultWhiteboard } from "@synap/database";

import { createContext } from "./context.js";

export {
  resolveProviderCredential,
  resolveProviderCredentialsBatch,
} from "./routers/ai-provider-credentials.js";

import { coreRouter } from "./root.js";
import type { AppRouter } from "./root.js";
export type { AppRouter };
export { coreRouter };

// Reactions / Pulse projection types — the read-only "Reactions" UI model.
export type {
  Reaction,
  ReactionKind,
  ReactionLens,
  ReactionEvent,
  WebhookDeliveryItem,
} from "./types/reactions.js";
export {
  INTERNAL_REACTION_KINDS,
  EXTERNAL_REACTION_KINDS,
} from "./types/reactions.js";

// Serve coreRouter (root.ts) DIRECTLY — the single source of truth. The dynamic
// registry is retired: it served a force-cast `as AppRouter` that had drifted
// from coreRouter (governanceRules/knowledge 404'd; diagnose/users/typesense/
// n8nActions served untyped). No plugin ever used it, and it snapshotted at boot
// so runtime registration was dead on arrival.
export const appRouter: AppRouter = coreRouter;

// Explicit re-export for server
export { createContext };

// ============================================================================
// DEPRECATED: Re-exports from @synap/shared-utils for backward compatibility
// These will be removed in a future version. Import directly from
// @synap/shared-utils instead.
// ============================================================================

/** @deprecated Import from @synap/shared-utils instead */
export {
  withRetry,
  withRetryResult,
  RetryableError,
  NonRetryableError,
  sleep,
  DB_RETRY_OPTIONS,
  API_RETRY_OPTIONS,
  type RetryOptions,
} from "@synap/shared-utils";

/** @deprecated Import from @synap/shared-utils instead */
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  circuitBreakerRegistry,
  type CircuitState,
  type CircuitBreakerOptions,
  type CircuitBreakerStats,
} from "@synap/shared-utils";

export {
  routeSignal,
  type RouteSignalInput,
  type RouteSignalResult,
  type SignalDomain,
  type SurfaceKind,
  type SurfaceResult,
} from "./utils/delivery-router.js";

export {
  runMailFeed,
  type RunMailFeedResult,
} from "./services/mail-feed/run-mail-feed.js";
export {
  runCalBackfill,
  type RunCalBackfillResult,
} from "./services/calcom/run-cal-backfill.js";
export {
  runFirefliesIngest,
  type RunFirefliesIngestInput,
  type RunFirefliesIngestResult,
} from "./services/fireflies/run-fireflies-ingest.js";
export {
  runFirefliesBackfill,
  type RunFirefliesBackfillResult,
} from "./services/fireflies/run-fireflies-backfill.js";
export { runInboundAttachmentIngest } from "./services/connectors/ingest-inbound-attachments.js";
export {
  runEventSync,
  type RunEventSyncResult,
} from "./services/event-sync/run-event-sync.js";
export {
  runGcalImport,
  type RunGcalImportResult,
} from "./services/event-sync/run-gcal-import.js";
export { scanStaleProposals } from "./services/proposals/scan-stale-proposals.js";
export { scanBrokenAutomations } from "./services/automations/scan-broken-automations.js";
export {
  runEventEnd,
  type RunEventEndResult,
} from "./services/event-end/run-event-end.js";
export {
  runSessionRecap,
  type RunSessionRecapInput,
  type RunSessionRecapResult,
} from "./services/session-recap/run-session-recap.js";
export {
  executeCapability,
  type ExecuteCapabilityResult,
} from "./services/capabilities/execute-capability.js";
// Exported for the @synap/jobs flow-validator IoC slot: the pattern detector
// writes `automations` directly and cannot import this package statically.
export {
  validateFlowDefinition,
  flowValidationErrorMessage,
} from "./services/automations/validate-flow.js";
export {
  runPlaybook,
  type RunPlaybookInput,
  type RunPlaybookResult,
  type RunChainContext,
} from "./services/playbooks/run-playbook.js";
export type { ConnectionSelector } from "./connectors/external-dispatch.js";
// Nango's API shape (connection_id ≠ end_user.id) belongs in the connector, not
// in routes — apps/api's Nango webhook needs it to attribute a sync correctly.
export { NangoConnector } from "./connectors/NangoConnector.js";
