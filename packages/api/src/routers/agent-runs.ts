/**
 * Agent Runs tRPC Router — read-only list over the event log.
 *
 * An agent run is persisted as an `agentRun.create.completed` event with
 * first-class telemetry columns (cost / tokens / latency / tool count /
 * authorship) by POST /api/hub/agent-runs. This router is the read
 * counterpart: a "watch your agent work" feed for the browser.
 *
 * Auth: protectedProcedure (Kratos session cookie). Scoping is USER-scoped —
 * `userId = ctx.userId`, matching the `workspace_as_lens` principle and the
 * sibling `events.read` procedure. An optional `workspaceId` narrows the feed
 * but never widens it.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { getEventRepository } from "@synap/database";

export const agentRunsRouter = router({
  /**
   * List completed agent runs for the current user, newest first.
   *
   * Returns the telemetry projection of each `agentRun.create.completed`
   * event. Non-telemetry context (summary / workspaceId / sessionId) is read
   * from the event's `data` JSONB.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        limit: z.number().min(1).max(200).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const eventRepo = getEventRepository();

      const runs = await eventRepo.listAgentRuns({
        userId,
        workspaceId: input.workspaceId,
        limit: input.limit,
      });

      return runs.map((e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        return {
          id: e.id,
          agentUserId: e.agentUserId,
          agentType: e.agentType,
          model: e.model,
          provider: e.provider,
          costUsd: e.costUsd,
          tokensIn: e.tokensIn,
          tokensOut: e.tokensOut,
          tokensTotal: e.tokensTotal,
          latencyMs: e.latencyMs,
          toolCount: e.toolCount,
          runStatus: e.runStatus,
          finishReason: e.finishReason,
          summary: typeof data.summary === "string" ? data.summary : undefined,
          workspaceId:
            typeof data.workspaceId === "string" ? data.workspaceId : undefined,
          sessionId:
            typeof data.sessionId === "string" ? data.sessionId : undefined,
          correlationId: e.correlationId,
          createdAt: e.timestamp,
        };
      });
    }),
});
