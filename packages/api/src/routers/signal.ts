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
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { db, eq } from "@synap/database";
import { channels } from "@synap/database/schema";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { proposeChannelUnbind } from "../utils/propose-channel-unbind.js";
import { channelsRouter } from "./channels.js";
import {
  listPipeline,
  resolveProvenance,
  getSignalSummary,
  listChannels,
  listEgress,
  getCapabilityHealth,
  getCapabilityIssues,
  resolveTuneTarget,
  getQualityByVersion,
  getChannelStack,
  resolveChannelRerun,
  resolveCapabilityChannelIds,
} from "../services/signal/index.js";
import { getIntegrationRoutingRules } from "../services/signal/integration-routing.js";
import { automationsRouter } from "./automations.js";

/**
 * Bound on `integrationReplay` — the number of channels a single bulk-replay
 * call will sweep. Deliberately small: each channel sweep opens (or proposes)
 * a real automation run, so an unbounded fan-out would be an unbounded write
 * storm. `channelsScanned < totalChannels` (i.e. `capped: true`) tells the
 * caller to re-invoke for the remainder rather than silently dropping them.
 */
const MAX_REPLAY_CHANNELS = 50;

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
        /** Capability lens: scope the stream to the channels a capability produced. */
        capabilityId: z.string().optional(),
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
        capabilityId: input.capabilityId,
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
        /** Capability lens: restrict the rollup to a capability's produced channels. */
        capabilityId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return listChannels({
        userId,
        order: input.order,
        capabilityId: input.capabilityId,
      });
    }),

  /**
   * The OUTBOUND half of the capability lens — a per-channel rollup of what the
   * capability (or the pod) SENT toward its external channels: authored outbound
   * messages (`sentCount` + `lastSentAt`, from the `messages` ledger) plus
   * terminal outbox-delivery failures (`failedCount`, from `channel_egress`).
   * Same floors + capability derivation as `channels`; a distinct return shape
   * because outbound carries no extraction fate. `problems` (default) floats
   * failing channels first; `recent` orders by last send.
   */
  egress: protectedProcedure
    .input(
      z.object({
        order: z.enum(["problems", "recent"]).optional(),
        /** Capability lens: restrict the rollup to a capability's produced channels. */
        capabilityId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return listEgress({
        userId,
        order: input.order,
        capabilityId: input.capabilityId,
      });
    }),

  /**
   * Pod-wide signal aggregates for the attention band (cheap COUNTs). With
   * `capabilityId` set, every tile is scoped to that capability's channels.
   */
  summary: protectedProcedure
    .input(z.object({ capabilityId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return getSignalSummary(userId, input?.capabilityId);
    }),

  /**
   * Producer mode (standing vs callable) + per-mode health for ONE capability —
   * the callable-vs-standing axis of the external-data lens. Standing health is
   * last-seen liveness (a quiet bridge reads `idle`, never `failed`); callable
   * health is run success-rate (suppressed no-ops excluded from the denominator).
   * A distinct door so the frozen `summary` / `channels` / `egress` shapes stay
   * intact. Floored inside the service.
   */
  capabilityHealth: protectedProcedure
    .input(z.object({ capabilityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return getCapabilityHealth(userId, input.capabilityId);
    }),

  /**
   * Intended-vs-actual DRIFT for ONE capability, as a ranked Issues list —
   * structural gaps (unwired/missing members, consolidated from the composition)
   * plus external-data runtime drift (failed extraction, unbound produced
   * channels, failed deliveries, a silent/idle standing source, an undeclared
   * mode on an observed capability). Severity is NOT boolean (error/warning/info);
   * each Issue carries a human sentence + a Fix mapped to an EXISTING action.
   * Derived every read — no new store. Floored inside the service.
   */
  capabilityIssues: protectedProcedure
    .input(z.object({ capabilityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return getCapabilityIssues(userId, input.capabilityId);
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

  /**
   * Integration dashboard — Stream facet "Replay": bulk re-analysis over ALL
   * of an integration's channels. NOT a new extraction path — this is
   * `channelRerun` above, looped over the capability's channel lens
   * (`resolveCapabilityChannelIds`, the same resolver `integrationStream`
   * scopes to). Each channel sweep goes through the identical governed door
   * (`automations.trigger` → `checkPermissionOrPropose`), so a bulk replay
   * can produce proposals exactly like a single one — never an auto-exec
   * shortcut. Bounded to `MAX_REPLAY_CHANNELS` per call so it can't become an
   * unbounded run-creation storm; `capped: true` means call again to sweep
   * the remainder.
   */
  integrationReplay: protectedProcedure
    .input(
      z.object({
        capabilityId: z.string().uuid(),
        /** Per-channel message-scan cap, forwarded to `resolveChannelRerun`. */
        limit: z.number().int().min(1).max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const channelIds = await resolveCapabilityChannelIds(
        userId,
        input.capabilityId
      );
      const capped = channelIds.length > MAX_REPLAY_CHANNELS;
      const scoped = channelIds.slice(0, MAX_REPLAY_CHANNELS);

      const caller = automationsRouter.createCaller(ctx);
      let channelsQueued = 0;
      let channelsProposed = 0;
      let channelsSkipped = 0;

      for (const channelId of scoped) {
        let resolved;
        try {
          // Same resolver `channelRerun` uses — picks the channel's bound
          // extraction automation and floors the message scan. A channel
          // with no bound automation (BAD_REQUEST) or that fell out of
          // visibility between the lens read and here (NOT_FOUND) is
          // skipped, not fatal to the rest of the sweep.
          resolved = await resolveChannelRerun({
            userId,
            channelId,
            limit: input.limit,
          });
        } catch {
          channelsSkipped++;
          continue;
        }

        const result = await caller.trigger({
          id: resolved.automationId,
          ...(resolved.boundEntityId
            ? { subjectEntityId: resolved.boundEntityId }
            : {}),
          payload: {
            type: "channel_rerun",
            channelId: resolved.channelId,
            entityId: resolved.boundEntityId,
            limit: resolved.scanned,
          },
          reasoning: `Integration replay: re-running "${
            resolved.automationName ?? resolved.automationId
          }" over ${resolved.scanned} message(s) on this channel`,
        });

        if (result.status === "proposed") {
          channelsProposed++;
        } else {
          channelsQueued++;
        }
      }

      return {
        channelsQueued,
        channelsProposed,
        channelsSkipped,
        channelsScanned: scoped.length,
        totalChannels: channelIds.length,
        capped,
      };
    }),

  /**
   * Integration dashboard — Analyzers facet: the automations bound to ONE
   * integration (capability composition)'s produced channels. "Bound" is a
   * union of the matcher-faithful per-channel binding (`channelStack`'s own
   * primitive) and capability-embedded `member_of` automations. Read-only,
   * additive — see `services/signal/integration-routing.ts`.
   */
  integrationRoutingRules: protectedProcedure
    .input(z.object({ capabilityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return getIntegrationRoutingRules(userId, input.capabilityId);
    }),

  /**
   * Unbind an ALREADY-BOUND channel from its context object — the "Remove"
   * action in the Channels view. Inverse of the hub-protocol `bindChannel`
   * door (`hub-protocol/channels.ts`): clears `contextObjectId` /
   * `contextObjectType` back to null. `branchPurpose` (the firewall role) is
   * DELIBERATELY left untouched — see `propose-channel-unbind.ts`.
   *
   *   User clicks "Remove"
   *     → checkPermissionOrPropose({ subjectType:"channel", action:"unbind" })
   *   Granted (ordinary editor+ member — the common case)
   *     → this procedure applies the clear itself via the GOVERNED
   *       channelsRouter.updateChannel (contextObjectType/Id: null) — the
   *       SAME one-door write the channel/bind and channel/unbind
   *       approve-executors both delegate to. NO raw UPDATE here.
   *   Insufficient role
   *     → a `channel/unbind` proposal is filed (PENDING) in the user's inbox;
   *       `"proposed"` is a normal outcome, not an error. On approval, the
   *       `channel/unbind` executor (executors/channel.ts) applies the same
   *       clear.
   *
   * ACCESS: gated on the CHANNEL ROW's own workspaceId (loaded from the DB via
   * `assertWorkspaceWrite`), never a client-supplied workspaceId — the
   * cross-workspace write-leak class `assertWorkspaceWrite` exists to close.
   */
  unbindChannel: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.channelId),
        columns: { id: true, workspaceId: true },
      });
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      // Gate on the LOADED row's workspaceId — never `ctx.workspaceId` / any
      // request-supplied value.
      await assertWorkspaceWrite(db, userId, {
        workspaceId: channel.workspaceId,
      });

      const result = await proposeChannelUnbind({
        userId,
        workspaceId: channel.workspaceId,
        channelId: input.channelId,
        reasoning: input.reasoning,
      });

      if (result.status === "denied") {
        throw new TRPCError({ code: "FORBIDDEN", message: result.reason });
      }

      if (result.status === "proposed") {
        return {
          status: "proposed" as const,
          proposalId: result.proposalId,
          reviewUrl: result.reviewUrl,
        };
      }

      // Granted — apply the clear through the ONE governed write door.
      await channelsRouter.createCaller(ctx).updateChannel({
        channelId: input.channelId,
        contextObjectType: null,
        contextObjectId: null,
      });

      return { status: "unbound" as const };
    }),
});
