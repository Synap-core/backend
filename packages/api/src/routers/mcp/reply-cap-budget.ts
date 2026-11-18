/**
 * The reply cap's budget, alone so `handlers/fit-reply.ts` (which the cap
 * calls) can read it without an import cycle through `reply-cap.ts`.
 */

/** Characters (not tokens) one text block may carry, ~4K tokens. */
export const REPLY_CAP_CHARS = 16_000;
