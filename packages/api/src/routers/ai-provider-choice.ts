/**
 * `aiProviderChoice.*` — the pod's choice of who runs its AI (founder decision
 * 2026-10-27; the rule and the store live in `services/ai-provider-choice.ts`).
 *
 *   get    — any signed-in person: the current choice, the words to show, and
 *            whether THEY may choose (a pod admin) — a member is told to ask.
 *   choose — a signed-in pod admin, never an agent credential: choosing
 *            DeepSeek is a person's explicit consent, which no agent can give.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import { isPodAdmin } from "../utils/workspace-role.js";
import { isAgentCaller } from "../services/library/agent-door.js";
import {
  chooseAiProvider,
  readAiProviderChoice,
  StaleAiProviderChoiceWordingError,
} from "../services/ai-provider-choice.js";

export const aiProviderChoiceRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const state = await readAiProviderChoice();
    const mayChoose =
      !isAgentCaller({ agentUserId: ctx.agentUserId, keyType: ctx.keyType }) &&
      (await isPodAdmin(ctx.userId));
    return { ...state, mayChoose };
  }),

  choose: podAdminProcedure
    .input(
      z.object({
        choice: z.enum(["deepseek", "own_provider"]),
        wordingVersion: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (
        isAgentCaller({ agentUserId: ctx.agentUserId, keyType: ctx.keyType })
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "An agent credential cannot choose the pod's AI provider — a pod admin chooses it, signed in.",
        });
      }
      try {
        return await chooseAiProvider({
          choice: input.choice,
          wordingVersion: input.wordingVersion,
          decidedBy: ctx.userId,
        });
      } catch (err) {
        if (err instanceof StaleAiProviderChoiceWordingError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),
});
