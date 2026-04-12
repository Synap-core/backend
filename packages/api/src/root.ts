import { router } from "./trpc.js";
import { setupRouter } from "./routers/setup.js";
import { eventsRouter } from "./routers/events.js";
import { captureRouter } from "./routers/capture.js";
import { entitiesRouter } from "./routers/entities.js";
import { channelsRouter as chatRouter } from "./routers/channels.js";
import { proposalsRouter } from "./routers/proposals.js";
import { suggestionsRouter } from "./routers/suggestions.js";
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
import { skillsRouter } from "./routers/skills.js";
import { backgroundTasksRouter } from "./routers/background-tasks.js";
import { messageLinksRouter } from "./routers/message-links.js";
import { profilesRouter } from "./routers/profiles.js";
import { propertyDefsRouter } from "./routers/property-defs.js";
import { profilePropertiesRouter } from "./routers/profile-properties.js";
import { relationDefsRouter } from "./routers/relation-defs.js";
import { profileRelationsRouter } from "./routers/profile-relations.js";
import { intelligenceRouter } from "./routers/intelligence.js";
import { agentUsersRouter } from "./routers/agent-users.js";
import { mcpServersRouter } from "./routers/mcp-servers.js";
import { agentConfigsRouter } from "./routers/agent-configs.js";
import { widgetDefinitionsRouter } from "./routers/widget-definitions.js";
import { channelGatewayRouter } from "./routers/channel-gateway.js";
import { importRouter } from "./routers/import.js";
import { connectorsRouter } from "./routers/connectors-trpc.js";
import { notifCenterRouter } from "./routers/notif-center.js";
import { proactiveRouter } from "./routers/proactive.js";
import { syncManagementRouter } from "./routers/sync-management.js";
import { feedsRouter } from "./routers/feeds.js";

/**
 * Core API Router
 */
export const coreRouter = router({
  setup: setupRouter,
  events: eventsRouter,
  capture: captureRouter,
  entities: entitiesRouter,
  chat: chatRouter,
  proposals: proposalsRouter,
  suggestions: suggestionsRouter,
  system: systemRouter,
  hub: hubRouter,
  apiKeys: apiKeysRouter,
  health: healthRouter,
  integrations: webhooksRouter,
  documents: documentsRouter,
  content: contentRouter,
  storage: filesRouter,
  notifications: inboxRouter,
  intelligenceRegistry: intelligenceRegistryRouter,
  intelligence: intelligenceRouter,
  capabilities: capabilitiesRouter,
  search: searchRouter,
  relations: relationsRouter,
  graph: graphRouter,
  workspaces: workspacesRouter,
  views: viewsRouter,
  preferences: preferencesRouter,
  roles: rolesRouter,
  sharing: sharingRouter,
  templates: templatesRouter,
  whiteboards: whiteboardsRouter,
  skills: skillsRouter,
  backgroundTasks: backgroundTasksRouter,
  messageLinks: messageLinksRouter,
  // Dynamic Schema System
  profiles: profilesRouter,
  propertyDefs: propertyDefsRouter,
  profileProperties: profilePropertiesRouter,
  relationDefs: relationDefsRouter,
  profileRelations: profileRelationsRouter,
  agentUsers: agentUsersRouter,
  mcpServers: mcpServersRouter,
  agentConfigs: agentConfigsRouter,
  widgetDefinitions: widgetDefinitionsRouter,
  channelGateway: channelGatewayRouter,
  import: importRouter,
  connectors: connectorsRouter,
  notifCenter: notifCenterRouter,
  proactive: proactiveRouter,
  sync: syncManagementRouter,
  feeds: feedsRouter,
});

export type AppRouter = typeof coreRouter;
