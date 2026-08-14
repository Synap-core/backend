/**
 * Hub Protocol Router
 *
 * Service-to-service API for Intelligence Hub
 * All routes (except health) require API key with 'hub-protocol.read' or 'hub-protocol.write' scope
 *
 * Composed from sub-routers for better organization:
 * - context: Thread and user context
 * - search: Search operations
 * - entities: Entity operations
 * - documents: Document operations
 * - branches: Branch operations
 * - linking: Context linking operations
 * - signals: Signal feed operations (fetch, classify, capture, feed, subscriptions)
 */

import { router, publicProcedure } from "../../trpc.js";
import { contextRouter } from "./context.js";
import { searchRouter } from "./search.js";
import { entitiesRouter } from "./entities.js";
import { documentsRouter } from "./documents.js";
import { branchesRouter } from "./branches.js";
import { linkingRouter } from "./linking.js";
import { skillsRouter } from "./skills.js";
import { proposalsRouter } from "./proposals.js";
import { channelsRouter as hubChannelsRouter } from "./channels.js";
import { servicesRouter } from "./services.js";
import { hubViewsRouter } from "./views.js";
import { hubProfilesRouter } from "./profiles.js";
import { hubRelationsRouter } from "./relations.js";
import { sessionsRouter } from "./sessions.js";
import { compactedStatesRouter } from "./compacted-states.js";
import { hubWidgetDefinitionsRouter } from "./widget-definitions.js";
import { migrationRouter } from "./migration.js";
import { hubAutomationsRouter } from "./automations.js";
import { hubCommandsRouter } from "./commands.js";
import { signalsRouter } from "./signals.js";
import { hubRelationDefsRouter } from "./relation-defs.js";
import { hubPlaybooksRouter } from "./playbooks.js";
import { observationsRouter } from "./observations.js";

export const hubProtocolRouter = router({
  /**
   * Health check (no auth required)
   */
  health: publicProcedure.query(() => {
    return { status: "ok", service: "hub-protocol" };
  }),

  // Sub-routers
  context: contextRouter,
  search: searchRouter,
  entities: entitiesRouter,
  documents: documentsRouter,
  branches: branchesRouter,
  channels: hubChannelsRouter,
  linking: linkingRouter,
  skills: skillsRouter,
  proposals: proposalsRouter,
  services: servicesRouter,
  views: hubViewsRouter,
  profiles: hubProfilesRouter,
  relations: hubRelationsRouter,
  sessions: sessionsRouter,
  compactedStates: compactedStatesRouter,
  widgetDefinitions: hubWidgetDefinitionsRouter,
  migration: migrationRouter,
  automations: hubAutomationsRouter,
  commands: hubCommandsRouter,
  signals: signalsRouter,
  relationDefs: hubRelationDefsRouter,
  playbooks: hubPlaybooksRouter,
  // Key-authenticated door for recording external facts. Namespaced +
  // phase-restricted so it can never reach the materializer — see the router.
  observations: observationsRouter,
});
