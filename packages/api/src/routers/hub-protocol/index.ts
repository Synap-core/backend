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
 */

import { router, publicProcedure } from "../../trpc.js";
import { contextRouter } from "./context.js";
import { searchRouter } from "./search.js";
import { entitiesRouter } from "./entities.js";
import { documentsRouter } from "./documents.js";
import { branchesRouter } from "./branches.js";
import { linkingRouter } from "./linking.js";
import { skillsRouter } from "./skills.js";
import { backgroundTasksRouter } from "./background-tasks.js";

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
  linking: linkingRouter,
  skills: skillsRouter,
  backgroundTasks: backgroundTasksRouter,
});
