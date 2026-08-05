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
  getChannelStack,
  resolveChannelRerun,
} from "../services/signal/index.js";
import { automationsRouter } from "./automations.js";

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

  /**
   * The channel object's Stack facet: origin, external identity + channel-level
   * deep link, capabilities targeting the channel, and every automation that can
   * fire for it (with HOW it is bound). Dual-floored inside the service.
   */
  channelStack: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return getChannelStack({ userId, channelId: input.channelId });
    }),

  /**
   * Per-channel sweep: re-run the channel's extraction automation over its
   * recent inbound messages.
   *
   * GOVERNED BY DELEGATION — the run is opened through the canonical
   * `automations.trigger` door, which owns `assertWorkspaceWrite` (operator) and
   * `checkPermissionOrPropose` (agent → `automation.execute`, not in
   * DEFAULT_AUTO_APPROVE → a proposal). This procedure never inserts a run.
   * `"proposed"` is a normal outcome, not an error.
   */
  channelRerun: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        automationId: z.string().uuid().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const resolved = await resolveChannelRerun({
        userId,
        channelId: input.channelId,
        automationId: input.automationId,
        limit: input.limit,
      });

      const result = await automationsRouter.createCaller(ctx).trigger({
        id: resolved.automationId,
        // The trigger door rejects a mismatch against the automation's own
        // workspace, so we pass nothing and let it use the row's workspace.
        ...(resolved.boundEntityId
          ? { subjectEntityId: resolved.boundEntityId }
          : {}),
        payload: {
          // Caller params first, then the RESOLVED/authorized keys last so a
          // client can't override channelId/limit/entityId to redirect the run
          // at a channel `resolveChannelRerun` never floored (`channelVisibilityWhere`).
          ...(input.params ?? {}),
          type: "channel_rerun",
          channelId: resolved.channelId,
          entityId: resolved.boundEntityId,
          limit: resolved.scanned,
        },
        reasoning: `Re-running "${
          resolved.automationName ?? resolved.automationId
        }" over ${resolved.scanned} message(s) on this channel`,
      });

      if (result.status === "proposed") {
        return {
          status: "proposed" as const,
          proposalId: result.proposalId ?? undefined,
          scanned: resolved.scanned,
          message: `Re-run proposed for review (${resolved.scanned} message(s) in scope)`,
        };
      }
      return {
        status: "started" as const,
        runId: result.runId ?? undefined,
        scanned: resolved.scanned,
        message: `Re-run started over ${resolved.scanned} message(s)`,
      };
    }),
});
