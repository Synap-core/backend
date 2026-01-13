import { router } from "./trpc.js";
import { setupRouter } from "./routers/setup.js";
import { eventsRouter } from "./routers/events.js";
import { captureRouter } from "./routers/capture.js";
import { entitiesRouter } from "./routers/entities.js";
import { infiniteChatRouter as chatRouter } from "./routers/infinite-chat.js";
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
import { tagsRouter } from "./routers/tags.js";
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
  capabilities: capabilitiesRouter,
  tags: tagsRouter,
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
});

export type AppRouter = typeof coreRouter;
