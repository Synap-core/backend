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
export { syncReceiveApp } from "./routers/sync.js";
export { createHubProtocolCallerContext } from "./routers/hub-protocol/utils.js";
export { proposalsRouter } from "./routers/proposals.js";
export { resolveIntelligenceService } from "./utils/intelligence-routing.js";
export {
  ensurePersonalChannel,
  ensureProactiveFeedChannel,
} from "./utils/personal-channel.js";
export { mcpHttpApp } from "./routers/mcp/http-handler.js";
export { fileUploadApp } from "./routers/file-upload.js";
export { externalSkillsApp } from "./routers/external/skills.js";
export { externalChatApp } from "./routers/external/chat.js";
export { chatStreamApp } from "./routers/chat-stream.js";
export { openaiCompatApp } from "./routers/external/openai-compat.js";
export { apiKeysRouter } from "./routers/api-keys.js";
export { healthRouter } from "./routers/health.js";
export { projectsRouter } from "./routers/projects.js";
export { feedsRouter } from "./routers/feeds.js";
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

// Export event streaming utilities
export { eventStreamManager } from "./event-stream-manager.js";
export { setupEventBroadcasting } from "./setup-event-broadcasting.js";

// Export CORS cache for dynamic origin management
export {
  getDynamicCorsOrigins,
  setDynamicCorsOrigins,
} from "./utils/cors-cache.js";

// Export utilities for webhook handling
export {
  syncUserFromKratos,
  createDefaultWorkspace,
} from "./utils/kratos-sync.js";

// Export JWKS client for CP JWT verification
export { verifyCpJwt, clearJwksCache } from "./utils/jwks-client.js";
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

// Export Telegram bot token resolver (3-tier: vault → workspace setting → env)
export {
  resolveTelegramBotToken,
  clearTelegramTokenCache,
  resolveTelegramWebhookSecret,
  clearTelegramSecretCache,
} from "./utils/telegram-bot-token.js";
export {
  createAndVerifyHubInboundKey,
  type RegistrationOutcome,
  type RegistrationResult,
} from "./services/external-registration.js";

// Export Telegram bot forwarding and link token utilities
export {
  forwardTelegramMessageToAI,
  findTelegramUser,
} from "./utils/telegram-bot-forward.js";
export { consumeLinkToken } from "./utils/consume-link-token.js";

// Export utilities for default whiteboard creation
// Re-export ensureDefaultWhiteboard from @synap/database for convenience
export { ensureDefaultWhiteboard } from "@synap/database";

// ✅ ADDED: Export entity embedding helper for jobs package (Issue #5)
export { generateAndStoreEmbedding } from "./routers/entities-data.js";

import { eventsRouter } from "./routers/events.js";
import { captureRouter } from "./routers/capture.js";
import { entitiesRouter } from "./routers/entities.js";

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
import { searchRouter } from "./routers/search.js";
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
import { backgroundTasksRouter } from "./routers/background-tasks.js";
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
registerRouter("search", searchRouter, {
  version: "1.0.0",
  source: "core",
  description: "Full-text and semantic search",
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
registerRouter("backgroundTasks", backgroundTasksRouter, {
  version: "1.0.0",
  source: "core",
  description: "Background task management",
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

import { feedsRouter } from "./routers/feeds.js";
registerRouter("feeds", feedsRouter, {
  version: "1.0.0",
  source: "core",
  description: "Unified feed management (RSS and Proactive feeds)",
});

import { coreRouter } from "./root.js";
import type { AppRouter } from "./root.js";
export type { AppRouter };
export { coreRouter };

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
  FEED_RETRY_OPTIONS,
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

/** @deprecated Import from @synap/shared-utils instead */
export { calculateNextRun, isFeedDue } from "@synap/shared-utils";
