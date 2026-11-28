/**
 * Synap AI, as the person's own console reads it (pod admin): is it connected, is it paused, and what may it read
 * and do. Person-scoped: it answers for the signed-in person's own Synap AI only (`ctx.userId`).
 *
 * One door, one derivation: `synapAiStatus` (`services/synap-ai-ceiling.ts`) is built on the same reads the app chat
 * gate uses, so the page and the gate cannot disagree. A failed read throws (never a "not connected" nobody measured).
 */
import { router, protectedProcedure } from "../trpc.js";
import { synapAiStatus } from "../services/synap-ai-ceiling.js";

export const synapAiRouter = router({
  /** `{ connected, paused, keyId, agentUserId, grants }`; makes the Synap AI key on first need, like the chat gate. */
  status: protectedProcedure.query(({ ctx }) => synapAiStatus(ctx.userId)),
});
