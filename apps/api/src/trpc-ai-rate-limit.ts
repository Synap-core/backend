/**
 * The AI rate limit on the main `/trpc` mount.
 *
 * It used to be mounted on the EXACT paths `/trpc/chat.sendMessage` and
 * `/trpc/channels.sendMessage`. tRPC 11 batches by default and splits a batch
 * path on ",", so `/trpc/health.check,chat.sendMessage?batch=1` (or one AI
 * procedure repeated N times in one batch) ran paid AI turns with no AI limit.
 *
 * Now the procedure list is parsed exactly as the session gate parses it
 * (`trpcProcedurePaths`, the tRPC fetch adapter's own rule) and the limiter is
 * charged ONCE PER AI PROCEDURE in the request: a batch of N AI calls costs N
 * and is refused as a whole if any charge goes over the limit.
 *
 * `hono-rate-limiter` (0.4.2, read at the installed version) REFUNDS a hit in
 * its `finally` when the context is not finalized after `next` returns, and
 * over the limit it RETURNS its handler's response instead of calling `next`.
 * So the charges are NESTED: each charge's `next` is the next charge, and the
 * innermost one is the real `next` (the handler finalizes the context, so no
 * charge is refunded). A refusal at any depth is assigned to `c.res`, which
 * finalizes the context for every outer charge too.
 *
 * Tests: `trpc-ai-rate-limit.test.ts`.
 */

import type { MiddlewareHandler } from "hono";
import { trpcProcedurePaths } from "./trpc-session-gate.js";

/** Procedures that each start a paid AI turn. */
export const AI_TRPC_PROCEDURES: ReadonlySet<string> = new Set([
  "chat.sendMessage",
  "channels.sendMessage",
]);

/** How many AI procedures this `/trpc` request runs. */
export function countAiTrpcProcedures(url: string): number {
  return trpcProcedurePaths(url).filter((p) => AI_TRPC_PROCEDURES.has(p))
    .length;
}

/** `app.use("/trpc/*", trpcAiRateLimit(aiRateLimitMiddleware))`. */
export function trpcAiRateLimit(limiter: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    const charges = countAiTrpcProcedures(c.req.url);
    if (charges === 0) return next();
    const charge = async (remaining: number): Promise<void> => {
      const refused = await limiter(
        c,
        remaining > 1 ? () => charge(remaining - 1) : next
      );
      if (refused) c.res = refused;
    };
    await charge(charges);
  };
}
