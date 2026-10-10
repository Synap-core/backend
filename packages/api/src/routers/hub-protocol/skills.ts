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
import { assertMayActAs } from "./guard.js";

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
        /** When true, return only approved skills (agent-tool loader filter). */
        approved: z.boolean().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      assertMayActAs(ctx, input.userId);
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        input.workspaceId
      );
      const caller = regularSkillsRouter.createCaller(callerContext);

      // Agent-tool-loader exclusion (W5): this Hub endpoint is IS-only (its sole
      // backend consumer is GET /agent-skills/executable, which feeds the IS
      // agent-tool loader). The IS wraps each returned skill as an executable
      // isolate tool — but `builtin` (Tier-0, in-process handler) and `declarative`
      // (Tier-1, provider-verb) skills carry NO isolate code, so loading them would
      // fail. Exclude them HERE (the narrowest IS-only chokepoint) rather than on
      // the shared `skills.list`, which the browser UI reads directly and must
      // keep showing every kind.
      //
      // The kind filter runs IN THE QUERY, before the limit — never after it.
      // Filtering a `limit: 100` page afterwards let builtin/declarative rows
      // spend the page, so a user's newest instruction skills and rules could
      // silently fall off the end of what the IS ever saw. Each kind is paged
      // to exhaustion (`skills.list` caps a page at 100).
      const PAGE = 100;
      type Row = {
        kind: string | null;
        createdAt: Date | string;
        [k: string]: unknown;
      };
      const rows: Row[] = [];
      for (const kind of ["code", "instruction"] as const) {
        for (let offset = 0; ; offset += PAGE) {
          const { skills: page } = await caller.list({
            workspaceId: input.workspaceId,
            kind,
            status: input.status || "all",
            approved: input.approved,
            limit: PAGE,
            offset,
          });
          rows.push(...page);
          if (page.length < PAGE) break;
        }
      }
      // One list, newest first — the order the single query used to return.
      return rows.sort(
        (a: Row, b: Row) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
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
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      assertMayActAs(ctx, input.userId);
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || []
      );
      const caller = regularSkillsRouter.createCaller(callerContext);

      // Call regular API's get endpoint
      const result = await caller.get({
        id: input.skillId,
        workspaceId: input.workspaceId,
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
        /** The acting AGENT identity, when this create is agent-initiated —
         *  threaded into skills.create's checkPermissionOrPropose call below
         *  so an agent-initiated create is gated by the agent's role, not
         *  silently evaluated as the human owner (userId above). Mirrors the
         *  fix applied to skillsRouter.create's other REST callers. */
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertMayActAs(ctx, input.userId);
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
        agentUserId: input.agentUserId,
      });

      return { id: result.id };
    }),
});
