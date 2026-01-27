/**
 * Hub Protocol - Skills Router
 *
 * Thin wrapper around regular API endpoints.
 * Allows Intelligence Service to fetch user skills.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { skillsRouter as regularSkillsRouter } from "../skills.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const skillsRouter = router({
  /**
   * Get skills for user
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's list endpoint internally
   */
  getSkills: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        status: z.enum(["active", "inactive", "error", "all"]).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularSkillsRouter.createCaller(callerContext);

      // Call regular API's list endpoint
      const result = await caller.list({
        workspaceId: input.workspaceId,
        status: input.status || "all",
        limit: 100, // Get all active skills
      });

      return result.skills;
    }),

  /**
   * Get a single skill by ID
   * Requires: hub-protocol.read scope
   */
  getSkill: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        skillId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularSkillsRouter.createCaller(callerContext);

      // Call regular API's get endpoint
      const result = await caller.get({
        id: input.skillId,
      });

      return result.skill;
    }),

  /**
   * Create a new skill
   * Requires: hub-protocol.write scope
   */
  createSkill: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        code: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.enum(["action", "context", "utility", "custom"]).optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || []
      );
      const caller = regularSkillsRouter.createCaller(callerContext);

      const result = await caller.create({
        name: input.name,
        description: input.description,
        code: input.code,
        parameters: input.parameters,
        category: input.category,
        workspaceId: input.workspaceId,
      });

      return { id: result.id };
    }),
});
