/**
 * tRPC `needs` — what a space needs filled, once, by one provider (founder
 * decisions D2 and D3, 16 Nov 2026; migration 0426).
 *
 *   - `vocabulary` — the need list (`@synap-core/types/needs`).
 *   - `forWorkspace` — the needs a space's processes declare, each filled
 *     (with its provider) or empty (with the installed capabilities that
 *     could fill it).
 *   - `bind` — fill or clear one need: the ONE governed door
 *     (`bindSpaceNeedThroughGate`, shared with Hub `PUT
 *     /workspaces/:workspaceId/needs/:need`). An agent proposes.
 *
 * Both reads and the write check membership of the space first
 * (`assertWorkspaceUsable`): the space is the caller's input, a lens is not
 * an authorization.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertWorkspaceUsable } from "../trpc.js";
import { NEEDS } from "@synap-core/types/needs";
import {
  BindSpaceNeedInputSchema,
  bindSpaceNeedThroughGate,
  readSpaceNeeds,
} from "../services/needs/space-need-door.js";
import { SpaceNeedBindError } from "../services/needs/space-needs.js";

const needParam = z.string().trim().min(1).max(64);

export const needsRouter = router({
  vocabulary: protectedProcedure.query(() => ({ needs: NEEDS })),

  forWorkspace: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await assertWorkspaceUsable(ctx.userId, input.workspaceId);
      return readSpaceNeeds(input.workspaceId);
    }),

  bind: protectedProcedure
    .input(
      BindSpaceNeedInputSchema.extend({
        workspaceId: z.string().uuid(),
        need: needParam,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertWorkspaceUsable(ctx.userId, input.workspaceId);
      try {
        const r = await bindSpaceNeedThroughGate({
          userId: ctx.userId,
          agentUserId: ctx.agentUserId ?? null,
          workspaceId: input.workspaceId,
          need: input.need,
          providerCapabilityId: input.providerCapabilityId,
        });
        if (r.status === "denied") {
          throw new TRPCError({ code: "FORBIDDEN", message: r.reason });
        }
        return r;
      } catch (err) {
        if (err instanceof SpaceNeedBindError) {
          throw new TRPCError({
            code: err.code === "NO_SUCH_PROVIDER" ? "NOT_FOUND" : "BAD_REQUEST",
            message: err.message,
            cause: { reasonCode: err.code },
          });
        }
        throw err;
      }
    }),
});
