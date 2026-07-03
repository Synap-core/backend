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
import { playbooksRouter as regularPlaybooksRouter } from "../playbooks.js";
import { createHubProtocolCallerContext } from "./utils.js";

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
});
