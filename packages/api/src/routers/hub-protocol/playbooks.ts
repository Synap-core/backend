/**
 * Hub Protocol - Playbooks Router
 *
 * Exposes the GOVERNED playbook lifecycle to Intelligence Hub agents (IS / CLI /
 * MCP) over one path. Delegates to the regular `playbooksRouter.promote`, which
 * loads the session, gates the write on the loaded session's workspace, and runs
 * `checkPermissionOrPropose` — so an agent promotion returns `status: 'proposed'`
 * (awaiting review) while an operator promotion returns `status: 'promoted'`.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import {
  playbooksRouter as regularPlaybooksRouter,
  updateInputSchema,
} from "../playbooks.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { assertMayActAs } from "./guard.js";

export const hubPlaybooksRouter = router({
  /**
   * Promote a validated session into a reusable Playbook (runtime → config).
   * Requires: hub-protocol.write scope.
   * Governance: routed through the regular `promote` procedure — the write is
   * gated on the loaded session's workspace and `checkPermissionOrPropose`
   * ({ subjectType: 'playbook', action: 'create' }). Agent callers get
   * `status: 'proposed'`; operators get `status: 'promoted'`.
   */
  promote: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        sessionId: z.string().uuid(),
        name: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertMayActAs(ctx, input.userId);
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        ctx.scopes || [],
        undefined,
        ctx.sourceMessageId ?? undefined,
        undefined,
        input.agentUserId ?? undefined
      );
      const caller = regularPlaybooksRouter.createCaller(callerContext);
      return caller.promote({
        sessionId: input.sessionId,
        name: input.name,
        description: input.description,
        agentUserId: input.agentUserId,
        source: "intelligence",
        reasoning: input.reasoning,
      });
    }),

  /**
   * Update a playbook's definition (governed diff) — the door the analyzer
   * persona / in-app editor uses over the Hub. Delegates to the regular
   * `playbooks.update`, which gates on the LOADED playbook's workspace and runs
   * `checkPermissionOrPropose` — agent callers get `status: 'proposed'`,
   * operators the executed result. `userId` is the resolved owner (the REST seam
   * passes `c.get("userId")`), mirroring `promote`; `ctx.userId` is not reliably
   * typed on `scopedProcedure`.
   */
  update: scopedProcedure(["hub-protocol.write"])
    .input(updateInputSchema.extend({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { userId, ...rest } = input;
      assertMayActAs(ctx, userId);
      const callerContext = await createHubProtocolCallerContext(
        userId,
        ctx.scopes || [],
        undefined,
        ctx.sourceMessageId ?? undefined,
        undefined,
        rest.agentUserId ?? undefined
      );
      const caller = regularPlaybooksRouter.createCaller(callerContext);
      return caller.update(rest);
    }),
});
