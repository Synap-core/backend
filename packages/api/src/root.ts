import { router, mergeRouters } from "./trpc.js";
import { setupRouter } from "./routers/setup.js";
import { eventsRouter } from "./routers/events.js";
import { captureRouter } from "./routers/capture.js";
import { entitiesRouter } from "./routers/entities.js";
import { resourceStateRouter } from "./routers/resource-state.js";
import { channelsRouter as chatRouter } from "./routers/channels.js";
import { proposalsRouter } from "./routers/proposals.js";
import { suggestionsRouter } from "./routers/suggestions.js";
import { systemRouter } from "./routers/system.js";
import { hubRouter } from "./routers/hub.js";
import { apiKeysRouter } from "./routers/api-keys.js";
import { healthRouter } from "./routers/health.js";
import { webhooksRouter } from "./routers/webhooks.js";
import { documentsRouter } from "./routers/documents.js";
import { capturesRouter } from "./routers/captures.js";
import { contentRouter } from "./routers/content.js";
import { filesRouter } from "./routers/files.js";
import { inboxRouter } from "./routers/inbox.js";
import { intelligenceRegistryRouter } from "./routers/intelligence-registry.js";
import { capabilitiesRouter } from "./routers/capabilities.js";
import { relationsRouter } from "./routers/relations.js";
import { graphRouter } from "./routers/graph.js";
import {
  workspacesRouter,
  workspaceCatalogRouter,
} from "./routers/workspaces.js";
import { viewsRouter } from "./routers/views.js";
import { preferencesRouter } from "./routers/preferences.js";
import { rolesRouter } from "./routers/roles.js";
import { sharesRouter } from "./routers/shares.js";
import { formsRouter } from "./routers/forms.js";
import { templatesRouter } from "./routers/templates.js";
import { whiteboardsRouter } from "./routers/whiteboards.js";
import { skillsRouter } from "./routers/skills.js";
import { toolsRouter } from "./routers/tools.js";
import { messageLinksRouter } from "./routers/message-links.js";
import { commentsRouter } from "./routers/comments.js";
import { profilesRouter } from "./routers/profiles.js";
import { surfacesRouter } from "./routers/surfaces.js";
import { propertyDefsRouter } from "./routers/property-defs.js";
import { profilePropertiesRouter } from "./routers/profile-properties.js";
import { relationDefsRouter } from "./routers/relation-defs.js";
import { profileRelationsRouter } from "./routers/profile-relations.js";
import { intelligenceRouter } from "./routers/intelligence.js";
import { agentUsersRouter } from "./routers/agent-users.js";
import { governanceRulesRouter } from "./routers/governance-rules.js";
import { governanceCeilingsRouter } from "./routers/governance-ceilings.js";
import { guidelinesRouter } from "./routers/guidelines.js";
import { govConfigRouter } from "./routers/gov-config.js";
import { mcpServersRouter } from "./routers/mcp-servers.js";
import { agentConfigsRouter } from "./routers/agent-configs.js";
import { widgetDefinitionsRouter } from "./routers/widget-definitions.js";
import { cellsRouter } from "./routers/cells.js";
import { cellInstancesRouter } from "./routers/cell-instances.js";
import { channelGatewayRouter } from "./routers/channel-gateway.js";
import { importRouter } from "./routers/import.js";
import { connectorsRouter } from "./routers/connectors-trpc.js";
import { notifCenterRouter } from "./routers/notif-center.js";
import { proactiveRouter } from "./routers/proactive.js";
import { syncManagementRouter } from "./routers/sync-management.js";
import { trustedIssuersRouter } from "./routers/trusted-issuers.js";
import { applicationConnectionsRouter } from "./routers/application-connections.js";
import { sourceConfigsRouter } from "./routers/source-configs.js";
import { sourceSubscriptionsRouter } from "./routers/source-subscriptions.js";
import { feedsRouter } from "./routers/feeds.js";
import { agentsRouter } from "./routers/agents.js";
import { devplaneRouter } from "./routers/devplane.js";
import { auditRouter } from "./routers/audit.js";
import { secretsVaultRouter } from "./routers/secrets-vault.js";
import { subscriptionsRouter } from "./routers/subscriptions.js";
import { aiProvidersRouter } from "./routers/ai-providers.js";
import { aiProviderCredentialsRouter } from "./routers/ai-provider-credentials.js";
import { focusSessionsRouter } from "./routers/focus-sessions.js";
import { playbooksRouter } from "./routers/playbooks.js";
import { playbookRunsRouter } from "./routers/playbook-runs.js";
import { agentRunsRouter } from "./routers/agent-runs.js";
import { activityRouter } from "./routers/activity.js";
import { runsRouter } from "./routers/runs.js";
import { workflowsRouter } from "./routers/workflows.js";
import { artifactsRouter } from "./routers/artifacts.js";
import { projectsRouter } from "./routers/projects.js";
import { tracksRouter } from "./routers/tracks.js";
import { automationsRouter } from "./routers/automations.js";
import { knowledgeRouter } from "./routers/knowledge.js";
import { onboardingRouter } from "./routers/onboarding.js";
// Previously mounted ONLY via the dynamic `registerRouter` registry (so they
// were served but invisible to codegen). Folded into coreRouter so root.ts is
// the SINGLE source of truth for the served + typed API surface.
import { diagnoseRouter } from "./routers/diagnose.js";
import { signalRouter } from "./routers/signal.js";
import { signalsRouter } from "./routers/signals.js";
import { typesenseRouter } from "./routers/typesense.js";
import { n8nActionsRouter } from "./routers/n8n/actions.js";
import { usersRouter } from "./routers/users.js";
import { placesRouter } from "./routers/places.js";

/**
 * Core API Router
 */
export const coreRouter = router({
  setup: setupRouter,
  events: eventsRouter,
  capture: captureRouter,
  entities: entitiesRouter,
  resourceState: resourceStateRouter,
  chat: chatRouter,
  proposals: proposalsRouter,
  suggestions: suggestionsRouter,
  system: systemRouter,
  hub: hubRouter,
  apiKeys: apiKeysRouter,
  health: healthRouter,
  integrations: webhooksRouter,
  documents: documentsRouter,
  captures: capturesRouter,
  content: contentRouter,
  storage: filesRouter,
  notifications: inboxRouter,
  intelligenceRegistry: intelligenceRegistryRouter,
  intelligence: intelligenceRouter,
  knowledge: knowledgeRouter,
  capabilities: capabilitiesRouter,
  relations: relationsRouter,
  graph: graphRouter,
  // Merge the workspace CATALOG procedures (browse + slug-install the
  // marketplace) into the `workspaces` namespace. Separate router only to break
  // a TS self-reference cycle (see workspaces.ts); same namespace to the client.
  workspaces: mergeRouters(workspacesRouter, workspaceCatalogRouter),
  views: viewsRouter,
  preferences: preferencesRouter,
  roles: rolesRouter,
  // Sites W2 S3 — the owner's share doors (services/sharing).
  shares: sharesRouter,
  // Sites W4 — the owner's public-form doors (services/forms).
  forms: formsRouter,
  templates: templatesRouter,
  whiteboards: whiteboardsRouter,
  skills: skillsRouter,
  tools: toolsRouter,
  messageLinks: messageLinksRouter,
  // Documents v2 — comments are anchored messages in the object's ONE room.
  comments: commentsRouter,
  // Dynamic Schema System
  profiles: profilesRouter,
  // Surfaces plane — renderer usage-health (how each record type is displayed)
  surfaces: surfacesRouter,
  propertyDefs: propertyDefsRouter,
  profileProperties: profilePropertiesRouter,
  relationDefs: relationDefsRouter,
  profileRelations: profileRelationsRouter,
  agentUsers: agentUsersRouter,
  governanceRules: governanceRulesRouter,
  governanceCeilings: governanceCeilingsRouter,
  guidelines: guidelinesRouter,
  govConfig: govConfigRouter,
  mcpServers: mcpServersRouter,
  agentConfigs: agentConfigsRouter,
  agents: agentsRouter,
  widgetDefinitions: widgetDefinitionsRouter,
  cells: cellsRouter,
  cellInstances: cellInstancesRouter,
  channelGateway: channelGatewayRouter,
  import: importRouter,
  connectors: connectorsRouter,
  notifCenter: notifCenterRouter,
  proactive: proactiveRouter,
  sync: syncManagementRouter,
  trustedIssuers: trustedIssuersRouter,
  applicationConnections: applicationConnectionsRouter,
  sourceConfigs: sourceConfigsRouter,
  sourceSubscriptions: sourceSubscriptionsRouter,
  feeds: feedsRouter,
  automations: automationsRouter,
  devplane: devplaneRouter,
  audit: auditRouter,
  secretsVault: secretsVaultRouter,
  subscriptions: subscriptionsRouter,
  aiProviders: aiProvidersRouter,
  aiProviderCredentials: aiProviderCredentialsRouter,
  focusSessions: focusSessionsRouter,
  playbooks: playbooksRouter,
  playbookRuns: playbookRunsRouter,
  agentRuns: agentRunsRouter,
  activity: activityRouter,
  runs: runsRouter,
  workflows: workflowsRouter,
  artifacts: artifactsRouter,
  projects: projectsRouter,
  tracks: tracksRouter,
  onboarding: onboardingRouter,
  diagnose: diagnoseRouter,
  signal: signalRouter,
  signals: signalsRouter,
  typesense: typesenseRouter,
  n8nActions: n8nActionsRouter,
  users: usersRouter,
  // Places — "open where it lives" (entity → source app target).
  places: placesRouter,
});

export type AppRouter = typeof coreRouter;
