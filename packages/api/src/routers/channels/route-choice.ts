/**
 * `channels.answerRouteChoice` — the person tapped one of the room's "who
 * should answer?" chips (`RouteChoiceMeta`). The chosen agent answers the
 * original message (`answerRoomChoice`, re-routed through THE route).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, channels } from "@synap/database";
import { protectedProcedure } from "../../trpc.js";
import { aiRateLimitMiddleware } from "../../middleware/ai-rate-limit.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { answerRoomChoice } from "../../services/agent-dispatch/route-room.js";

export const answerRouteChoiceProcedure = protectedProcedure
  // A tap starts an AI turn: the same limit as sending a message.
  .use(aiRateLimitMiddleware)
  .input(
    z.object({
      channelId: z.string().uuid(),
      /** The system message that carries the choice. */
      choiceMessageId: z.string().uuid(),
      agentUserId: z.string().uuid(),
    })
  )
  .mutation(async ({ ctx, input }) => {
    // The same floor as reading the room (the access layer's channel rule):
    // an invisible channel is NOT_FOUND.
    const visible = await scopedDb(AccessContext.from(ctx)).findFirst(
      channels,
      { where: eq(channels.id, input.channelId), columns: { id: true } }
    );
    if (!visible) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
    }
    const res = await answerRoomChoice({
      channelId: input.channelId,
      callerId: ctx.userId!,
      choiceMessageId: input.choiceMessageId,
      agentUserId: input.agentUserId,
    });
    if (res.status === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "That choice is gone",
      });
    }
    return res;
  });
