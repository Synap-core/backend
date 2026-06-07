/**
 * Hub Protocol REST — register-fns barrel.
 *
 * Each `register*Routes(app)` adds a slice of routes to the given Hono app.
 * The root `hub-protocol-rest.ts` orchestrator owns auth middleware and
 * mount order, then calls these registers in the right order.
 */

export { registerAuthRoutes, registerExchangeRoutes } from "./auth.js";
export { registerHealthRoutes } from "./health.js";
export { registerUsersRoutes } from "./users.js";
export { registerWorkspacesRoutes } from "./workspaces.js";
export { registerThreadsRoutes } from "./threads.js";
export { registerEventsRoutes } from "./events.js";
export { registerEntitiesRoutes } from "./entities.js";
export { registerCaptureRoutes } from "./capture.js";
export { registerSearchRoutes } from "./search.js";
export { registerDocumentsRoutes } from "./documents.js";
export { registerProposalsRoutes } from "./proposals.js";
export { registerSkillsRoutes } from "./skills.js";
export { registerMemoryRoutes } from "./memory.js";
export { registerKnowledgeRoutes } from "./knowledge.js";
export { registerCommandsRoutes } from "./commands.js";
export { registerAgentUsersRoutes } from "./agent-users.js";
export { registerAgentConfigsRoutes } from "./agent-configs.js";
export { registerViewsRoutes } from "./views.js";
export { registerProfilesRoutes } from "./profiles.js";
export { registerRelationsRoutes } from "./relations.js";
export { registerRelationDefsRoutes } from "./relation-defs.js";
export { registerSessionsRoutes } from "./sessions.js";
export { registerWidgetDefinitionsRoutes } from "./widget-definitions.js";
export { registerCellsRoutes } from "./cells.js";
export { registerCellInstancesRoutes } from "./cell-instances.js";
export { registerWhiteboardsRoutes } from "./whiteboards.js";
export { registerMcpServersRoutes } from "./mcp-servers.js";
export { registerAutomationsRoutes } from "./automations.js";
export { registerBackgroundTasksRoutes } from "./background-tasks.js";
export { registerVaultRoutes } from "./vault.js";
export { registerChannelsRoutes } from "./channels.js";
export { registerTerminalRoutes } from "./terminal.js";
export { registerProactiveRoutes } from "./proactive.js";
export { registerNotificationsRoutes } from "./notifications.js";
export { registerEntityShareRoutes } from "./entity-share.js";
export { registerSetupRoutes } from "./setup.js";
export { registerAgentsRoutes } from "./agents.js";
export { registerMessagingRoutes } from "./messaging.js";
export { registerConnectorsRoutes } from "./connectors.js";
export { registerWebhooksRoutes } from "./webhooks.js";
export { registerSubscriptionsRoutes } from "./subscriptions.js";
export { registerManifestRoutes } from "./manifest.js";
export { registerDiscoverRoutes } from "./discover.js";
export { registerKeysRoutes } from "./keys.js";
export { registerAiProvidersRoutes } from "./ai-providers.js";

export type { HubHono } from "./_shared.js";
