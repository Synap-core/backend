/**
 * API Package - Main Export
 */

import { initializePlugins } from "./plugins/init.js";

// Initialize plugins at module load
// This ensures plugins are registered before the app router is built
initializePlugins().catch((error) => {
  console.error("Failed to initialize plugins:", error);
});
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

import { eventsRouter } from "./routers/events.js";
import { captureRouter } from "./routers/capture.js";
import { entitiesRouter } from "./routers/entities.js";
import { resourceStateRouter } from "./routers/resource-state.js";

import { channelsRouter as chatRouter } from "./routers/channels.js";
import { proposalsRouter } from "./routers/proposals.js"; // NEW
import { suggestionsRouter } from "./routers/suggestions.js";
import { setupRouter } from "./routers/setup.js";
import { systemRouter } from "./routers/system.js";
import { hubRouter } from "./routers/hub.js";
import { apiKeysRouter } from "./routers/api-keys.js";
import { healthRouter } from "./routers/health.js";
import { webhooksRouter } from "./routers/webhooks.js";
import { documentsRouter } from "./routers/documents.js";
import { contentRouter } from "./routers/content.js";
import { filesRouter } from "./routers/files.js";
import { inboxRouter } from "./routers/inbox.js";
import { intelligenceRegistryRouter } from "./routers/intelligence-registry.js";
import { intelligenceRouter } from "./routers/intelligence.js";
import { capabilitiesRouter } from "./routers/capabilities.js";
import { relationsRouter } from "./routers/relations.js";
import { graphRouter } from "./routers/graph.js";
import { workspacesRouter } from "./routers/workspaces.js";
import { viewsRouter } from "./routers/views.js";
import { preferencesRouter } from "./routers/preferences.js";
import { rolesRouter } from "./routers/roles.js";
import { sharingRouter } from "./routers/sharing.js";
import { templatesRouter } from "./routers/templates.js";
import { whiteboardsRouter } from "./routers/whiteboards.js";
import { projectsRouter } from "./routers/projects.js";
import { profilesRouter } from "./routers/profiles.js";
import { propertyDefsRouter } from "./routers/property-defs.js";
import { profilePropertiesRouter } from "./routers/profile-properties.js";
import { skillsRouter } from "./routers/skills.js";
import { messageLinksRouter } from "./routers/message-links.js";
import { typesenseRouter } from "./routers/typesense.js";
import { n8nActionsRouter } from "./routers/n8n/actions.js";
import { secretsVaultRouter } from "./routers/secrets-vault.js";
import { usersRouter } from "./routers/users.js";
import { agentConfigsRouter } from "./routers/agent-configs.js";
import { mcpServersRouter } from "./routers/mcp-servers.js";
import { relationDefsRouter } from "./routers/relation-defs.js";
import { profileRelationsRouter } from "./routers/profile-relations.js";
import { agentUsersRouter } from "./routers/agent-users.js";
import { widgetDefinitionsRouter } from "./routers/widget-definitions.js";
import { cellsRouter } from "./routers/cells.js";
import { channelGatewayRouter } from "./routers/channel-gateway.js";
import { automationsRouter } from "./routers/automations.js";
import { importRouter } from "./routers/import.js";
import { createContext } from "./context.js";
import { registerRouter, buildAppRouter } from "./router-registry.js";

// V1.0: Register core routers dynamically
// These are the built-in routers that come with the kernel
registerRouter("setup", setupRouter, {
  version: "1.0.0",
  source: "core",
  description: "System setup and initialization API",
});
registerRouter("events", eventsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Event logging API",
});
registerRouter("capture", captureRouter, {
  version: "1.0.0",
  source: "core",
  description: "Thought capture API",
});
registerRouter("entities", entitiesRouter, {
  version: "1.0.0",
  source: "core",
  description: "Entity management API",
});
registerRouter("resourceState", resourceStateRouter, {
  version: "1.0.0",
  source: "core",
  description: "Per-user resource presentation and explicit-open state",
});

registerRouter("chat", chatRouter, {
  version: "1.0.0",
  source: "core",
  description: "Infinite chat with branching and AI integration",
});
registerRouter("proposals", proposalsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Universal Proposal System",
}); // NEW
registerRouter("suggestions", suggestionsRouter, {
  version: "1.0.0",
  source: "core",
  description: "AI suggestions API",
});
registerRouter("system", systemRouter, {
  version: "1.0.0",
  source: "core",
  description: "System meta-information and control",
});
registerRouter("hub", hubRouter, {
  version: "1.0.0",
  source: "core",
  description: "Hub Protocol V1.0 - Intelligence Hub communication",
});
registerRouter("apiKeys", apiKeysRouter, {
  version: "1.0.0",
  source: "core",
  description: "API key management for Hub authentication",
});
registerRouter("health", healthRouter, {
  version: "1.0.0",
  source: "core",
  description: "Health checks and system monitoring",
});
registerRouter("integrations", webhooksRouter, {
  version: "1.0.0",
  source: "core",
  description: "Webhook subscription management",
});
registerRouter("documents", documentsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Document management and collaboration",
});
registerRouter("content", contentRouter, {
  version: "1.0.0",
  source: "core",
  description: "Unified content creation (notes and files)",
});
registerRouter("storage", filesRouter, {
  version: "1.0.0",
  source: "core",
  description: "File storage browsing and management",
});
registerRouter("notifications", inboxRouter, {
  version: "1.0.0",
  source: "core",
  description: "Life Feed inbox and notifications",
});
registerRouter("intelligenceRegistry", intelligenceRegistryRouter, {
  version: "1.0.0",
  source: "core",
  description: "Intelligence Service Registry",
});
registerRouter("intelligence", intelligenceRouter, {
  version: "1.0.0",
  source: "core",
  description: "Commands, runs, and effective service for Intelligence app",
});
registerRouter("capabilities", capabilitiesRouter, {
  version: "1.0.0",
  source: "core",
  description: "Feature and service discovery",
});
registerRouter("relations", relationsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Entity relationship management",
});
registerRouter("relationDefs", relationDefsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Custom relation type definition management",
});
registerRouter("profileRelations", profileRelationsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Profile-to-profile relation management (dynamic schema system)",
});
registerRouter("agentUsers", agentUsersRouter, {
  version: "1.0.0",
  source: "core",
  description: "AI agent user management",
});
registerRouter("graph", graphRouter, {
  version: "1.0.0",
  source: "core",
  description: "Graph-optimized bulk queries",
});
registerRouter("workspaces", workspacesRouter, {
  version: "1.0.0",
  source: "core",
  description: "Workspace and team management",
});
registerRouter("views", viewsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Views system (whiteboards, timelines, etc.)",
});
registerRouter("preferences", preferencesRouter, {
  version: "1.0.0",
  source: "core",
  description: "User preferences management",
});
registerRouter("roles", rolesRouter, {
  version: "1.0.0",
  source: "core",
  description: "Custom role management",
});
registerRouter("sharing", sharingRouter, {
  version: "1.0.0",
  source: "core",
  description: "Public and invite-based sharing",
});
registerRouter("templates", templatesRouter, {
  version: "1.0.0",
  source: "core",
  description: "Entity template management",
});
registerRouter("whiteboards", whiteboardsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Whiteboard version control and snapshots",
});
registerRouter("projects", projectsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Project management",
});
registerRouter("profiles", profilesRouter, {
  version: "1.0.0",
  source: "core",
  description: "Entity type profile management (dynamic schema system)",
});
registerRouter("propertyDefs", propertyDefsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Property definition management (dynamic schema system)",
});
registerRouter("profileProperties", profilePropertiesRouter, {
  version: "1.0.0",
  source: "core",
  description: "Profile-property linking management (dynamic schema system)",
});
registerRouter("skills", skillsRouter, {
  version: "1.0.0",
  source: "core",
  description: "User-created skills management",
});
registerRouter("messageLinks", messageLinksRouter, {
  version: "1.0.0",
  source: "core",
  description: "Message linking to entities, documents, and other objects",
});
registerRouter("typesense", typesenseRouter, {
  version: "1.0.0",
  source: "core",
  description: "Typesense search API for command palette and search",
});
registerRouter("n8nActions", n8nActionsRouter, {
  version: "1.0.0",
  source: "core",
  description: "n8n workflow actions integration",
});
registerRouter("secretsVault", secretsVaultRouter, {
  version: "1.0.0",
  source: "core",
  description: "Encrypted secrets vault for passwords and API keys",
});
registerRouter("users", usersRouter, {
  version: "1.0.0",
  source: "core",
  description: "Current user identity and profile API",
});
registerRouter("agentConfigs", agentConfigsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Per-user agent configuration overrides (prompt, tools, model)",
});
registerRouter("mcpServers", mcpServersRouter, {
  version: "1.0.0",
  source: "core",
  description: "Workspace-level MCP server registry and health tracking",
});
registerRouter("widgetDefinitions", widgetDefinitionsRouter, {
  version: "1.0.0",
  source: "core",
  description:
    "Dynamic widget registry — built-in + AI-generated bento widget types",
});
registerRouter("cells", cellsRouter, {
  version: "1.0.0",
  source: "core",
  description:
    "ViewFrame cell marketplace lifecycle — install, uninstall, listInstalled",
});
import { cellInstancesRouter } from "./routers/cell-instances.js";
registerRouter("cellInstances", cellInstancesRouter, {
  version: "1.0.0",
  source: "core",
  description: "Per-surface cell instance placement and config",
});
registerRouter("channelGateway", channelGatewayRouter, {
  version: "1.0.0",
  source: "core",
  description: "External channel connections (Telegram, WhatsApp) management",
});
registerRouter("automations", automationsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Workflow automation CRUD and run history",
});
registerRouter("import", importRouter, {
  version: "1.0.0",
  source: "core",
  description:
    "Bulk import (JSON/Markdown/CSV) into entities, documents, and channels",
});
import { connectorsRouter as connectorsTrpcRouter } from "./routers/connectors-trpc.js";
registerRouter("connectors", connectorsTrpcRouter, {
  version: "1.0.0",
  source: "core",
  description: "External connector management (proxy to Control Plane)",
});

import { syncManagementRouter } from "./routers/sync-management.js";
registerRouter("sync", syncManagementRouter, {
  version: "1.0.0",
  source: "core",
  description: "Pod-to-pod sync peer management and status monitoring",
});

import { proactiveRouter } from "./routers/proactive.js";
registerRouter("proactive", proactiveRouter, {
  version: "1.0.0",
  source: "core",
  description: "Proactive intelligence pod-wide defaults",
});

import { trustedIssuersRouter } from "./routers/trusted-issuers.js";
registerRouter("trustedIssuers", trustedIssuersRouter, {
  version: "1.0.0",
  source: "core",
  description: "Trusted JWT issuer registry (CP-pod handshake)",
});

import { applicationConnectionsRouter } from "./routers/application-connections.js";
registerRouter("applicationConnections", applicationConnectionsRouter, {
  version: "1.0.0",
  source: "core",
  description:
    "Pod-owner review of browser application connection requests (federation)",
});

import { sourceConfigsRouter } from "./routers/source-configs.js";
registerRouter("sourceConfigs", sourceConfigsRouter, {
  version: "1.0.0",
  source: "core",
  description: "External data source configurations",
});

import { notifCenterRouter } from "./routers/notif-center.js";
registerRouter("notifCenter", notifCenterRouter, {
  version: "1.0.0",
  source: "core",
  description: "Notification center — user-wide list and mark-read",
});

import { agentsRouter } from "./routers/agents.js";
registerRouter("agents", agentsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Agent registry and sync",
});

import { auditRouter } from "./routers/audit.js";
registerRouter("audit", auditRouter, {
  version: "1.0.0",
  source: "core",
  description: "Audit log access",
});

import { devplaneRouter } from "./routers/devplane.js";
registerRouter("devplane", devplaneRouter, {
  version: "1.0.0",
  source: "core",
  description: "Developer plane tooling",
});

import { feedsRouter } from "./routers/feeds.js";
registerRouter("feeds", feedsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Activity feeds",
});

import { sourceSubscriptionsRouter } from "./routers/source-subscriptions.js";
registerRouter("sourceSubscriptions", sourceSubscriptionsRouter, {
  version: "1.0.0",
  source: "core",
  description: "External data source subscriptions",
});

import { aiProvidersRouter } from "./routers/ai-providers.js";
registerRouter("aiProviders", aiProvidersRouter, {
  version: "1.0.0",
  source: "core",
  description: "Pod-level AI provider registry",
});

import { aiProviderCredentialsRouter } from "./routers/ai-provider-credentials.js";
registerRouter("aiProviderCredentials", aiProviderCredentialsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Per-workspace and per-user AI provider key overrides",
});

import { focusSessionsRouter } from "./routers/focus-sessions.js";
registerRouter("focusSessions", focusSessionsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Goal-bound focus sessions (list/get/create/update/close)",
});

import { toolsRouter } from "./routers/tools.js";
registerRouter("tools", toolsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Tool definitions and invocation surface",
});

import { subscriptionsRouter } from "./routers/subscriptions.js";
registerRouter("subscriptions", subscriptionsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Pod subscription / billing surface",
});

import { playbooksRouter } from "./routers/playbooks.js";
registerRouter("playbooks", playbooksRouter, {
  version: "1.0.0",
  source: "core",
  description: "Playbook session templates",
});

import { playbookRunsRouter } from "./routers/playbook-runs.js";
registerRouter("playbookRuns", playbookRunsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Playbook run history",
});

import { agentRunsRouter } from "./routers/agent-runs.js";
registerRouter("agentRuns", agentRunsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Agent run history",
});

import { activityRouter } from "./routers/activity.js";
registerRouter("activity", activityRouter, {
  version: "1.0.0",
  source: "core",
  description: "Activity / timeline surface",
});

import { diagnoseRouter } from "./routers/diagnose.js";
registerRouter("diagnose", diagnoseRouter, {
  version: "1.0.0",
  source: "core",
  description: "Whole-pod health / what-needs-me surface",
});

import { runsRouter } from "./routers/runs.js";
registerRouter("runs", runsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Unified runs surface",
});

import { workflowsRouter } from "./routers/workflows.js";
registerRouter("workflows", workflowsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Workflow-place aggregation surface",
});

import { artifactsRouter } from "./routers/artifacts.js";
registerRouter("artifacts", artifactsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Run artifacts",
});

import { onboardingRouter } from "./routers/onboarding.js";
registerRouter("onboarding", onboardingRouter, {
  version: "1.0.0",
  source: "core",
  description: "Lens-aware contextual onboarding state and readiness",
});

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

// Export the dynamically built app router for the server
export const appRouter: AppRouter = buildAppRouter();

// Re-export router registry functions for plugin developers
export {
  registerRouter,
  unregisterRouter,
  dynamicRouterRegistry,
  getRouter,
  buildAppRouter,
} from "./router-registry.js";

// Re-export plugin system
export {
  pluginManager,
  // intelligenceHubPlugin,
  type DataPodPlugin,
  type ThoughtInput,
  type ThoughtResponse,
} from "./plugins/index.js";

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
export {
  runEventSync,
  type RunEventSyncResult,
} from "./services/event-sync/run-event-sync.js";
export {
  runGcalImport,
  type RunGcalImportResult,
} from "./services/event-sync/run-gcal-import.js";
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
