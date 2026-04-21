/**
 * Agents Router — tRPC routes for the agent identity layer.
 *
 * Public (podProcedure = auth optional):
 *  - agents.list    — list visible agents
 *  - agents.sync    — Hub Protocol authenticated sync (apiKey required)
 *
 * Protected (workspaceProcedure):
 *  - agents.workspaceList — workspace-scoped agent list
 *  - agents.getById/:id   — individual agent detail
 */

import { z } from "zod";
import { router, workspaceProcedure, podProcedure } from "./trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, desc, or, isNull, isNotNull } from "@synap/database";
import { agents, type Agent, type NewAgent } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "agents-router" });

/**
 * List visible agents — public listing (Pod Procedure).
 * Auth: optional (works for anonymous discovery of marketplace agents).
 */
export const agentsRouter = router({
  list: podProcedure
    .input(
      z.object({
        intelligenceServiceId: z.string().default(""),
        ownerType: z.enum(["system", "user", "provider"]).optional(),
        active: z.boolean().optional(),
      })
    )
    .query(async ({ input }) => {
      let query = db.select().from(agents).orderBy(desc(agents.createdAt));

      const where: ReturnType<typeof eq | typeof isNull | typeof isNotNull>[] =
        [];

      if (input.intelligenceServiceId === "") {
        where.push(isNull(agents.intelligenceServiceId));
      } else if (input.intelligenceServiceId) {
        where.push(
          eq(agents.intelligenceServiceId, input.intelligenceServiceId)
        );
      }

      if (input.ownerType) {
        where.push(eq(agents.ownerType, input.ownerType));
      }

      if (input.active !== undefined) {
        where.push(eq(agents.active, input.active));
      }

      if (where.length > 0) {
        query = query.where(and(...where));
      }

      return await query;
    }),

  /**
   * Workspace-scoped agent list (authenticated).
   * Default: show system + provider agents.
   */
  workspaceList: workspaceProcedure
    .input(
      z.object({
        ownerType: z.enum(["system", "provider"]).optional(),
      })
    )
    .query(async ({ input }) => {
      let query = db.select().from(agents).orderBy(desc(agents.createdAt));

      if (input.ownerType) {
        query = query.where(eq(agents.ownerType, input.ownerType));
      } else {
        query = query.where(
          or(eq(agents.ownerType, "system"), eq(agents.ownerType, "provider"))
        );
      }

      return await query;
    }),

  /**
   * Get a single agent by ID (workspace-scoped).
   */
  getById: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.id))
        .limit(1);

      if (!agent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Agent ${input.id} not found`,
        });
      }

      return agent;
    }),
});

export { agentsRouter };
