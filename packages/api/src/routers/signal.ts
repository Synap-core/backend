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
  listChannels,
  resolveTuneTarget,
  getQualityByVersion,
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
        /** Drill-down: scope the stream to a single channel (channel-detail view). */
        channelId: z.string().optional(),
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
        channelId: input.channelId,
      });
    }),

  /**
   * Per-channel rollup for the channel-first navigation spine. Same window +
   * floors as `pipeline`; `problems` (default) floats channels needing attention
   * first, `recent` orders by last activity.
   */
  channels: protectedProcedure
    .input(
      z.object({
        order: z.enum(["problems", "recent"]).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return listChannels({ userId, order: input.order });
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

  /**
   * Feedback loop — resolve a run to its "Tune extraction" target: the owning
   * automation + the `ai.generate` flow node the user would edit to fix a miss.
   */
  tuneTarget: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return resolveTuneTarget(userId, input.runId);
    }),

  /**
   * Feedback loop — extraction quality grouped by automation version (before/after
   * a prompt change). Optionally scoped to one automation.
   */
  qualityByVersion: protectedProcedure
    .input(z.object({ automationId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return getQualityByVersion({ userId, automationId: input?.automationId });
    }),
});
