/**
 * Signal Router — pod-wide pipeline observability.
 *
 * Two read doors over the inbound-message → AI-extraction → entities/proposals
 * pipeline (see services/signal/index.ts for the linkage map):
 *
 *   - `pipeline`   — the unified signal stream (inbound message + its fate).
 *   - `provenance` — reverse: proposal / entity / run → its source message(s).
 *
 * Auth: protectedProcedure. Floored inside the service — messages by
 * `channelVisibilityWhere`, runs/proposals by `userVisibleWhere` (the SAME
 * predicates every channel/proposal/run read uses).
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import {
  listPipeline,
  resolveProvenance,
  getSignalSummary,
} from "../services/signal/index.js";

export const signalRouter = router({
  /** Newest-first (or problems-first) stream of inbound signals + their fate. */
  pipeline: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).optional(),
        /**
         * Composite keyset cursor — the `nextCursor` (`"<iso>|<messageId>"`) from
         * the prior page. The id tie-breaks equal timestamps so no row straddles
         * a page boundary.
         */
        cursor: z.string().optional(),
        order: z.enum(["recent", "problems"]).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // Cursor is `"<iso>|<messageId>"`. ISO-8601 contains no `|` and a uuid
      // contains no `|`, so a single split cleanly separates the two halves.
      const [iso, beforeId] = input.cursor ? input.cursor.split("|") : [];
      return listPipeline({
        userId,
        limit: input.limit,
        before: iso ? new Date(iso) : undefined,
        beforeId: beforeId || undefined,
        order: input.order,
      });
    }),

  /** Pod-wide signal aggregates for the attention band (cheap COUNTs). */
  summary: protectedProcedure.query(async ({ ctx }) => {
    const userId = requireUserId(ctx.userId);
    return getSignalSummary(userId);
  }),

  /** Given a proposal / entity / run id, resolve back to its source message(s). */
  provenance: protectedProcedure
    .input(
      z.object({
        kind: z.enum(["proposal", "entity", "run"]),
        id: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return resolveProvenance({ userId, kind: input.kind, id: input.id });
    }),
});
