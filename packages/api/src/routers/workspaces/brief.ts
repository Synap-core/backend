/**
 * `workspaces.updateBrief` — the tRPC face of the ONE brief edit door
 * (`services/space-brief-door.ts` `updateSpaceBriefGoverned`), the same door
 * the MCP `synap_update_space_brief` tool calls.
 *
 * Governance is the door's, unchanged: `checkPermissionOrPropose` under the
 * `workspace/update` gate with `operation: "update_brief"` — an agent always
 * PROPOSES (ADMIN floor); a user write passes the normal gate. The input is
 * validated by the door's own `spaceBriefPatchSchema`, whose keys are held
 * equal to the canonical `SpaceBriefPatch` by a compile floor there — so the
 * client type generated from this procedure IS the canonical patch.
 */
import { z } from "zod";
import { protectedProcedure } from "../../trpc.js";
import {
  spaceBriefPatchSchema,
  updateSpaceBriefGoverned,
} from "../../services/space-brief-door.js";

export const briefProcedures = {
  updateBrief: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        /** A value REPLACES that field; `null` REMOVES it; absent = untouched. */
        patch: spaceBriefPatchSchema,
        reasoning: z.string().max(2000).optional(),
      })
    )
    .mutation(({ input, ctx }) =>
      updateSpaceBriefGoverned({
        userId: ctx.userId,
        agentUserId:
          (ctx as { agentUserId?: string | null }).agentUserId ?? null,
        workspaceId: input.workspaceId,
        patch: input.patch,
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      })
    ),
};
