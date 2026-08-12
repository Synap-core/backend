/**
 * Diagnose Router — "what needs me across the pod", over tRPC.
 *
 * A THIN wrapper around the SAME `diagnoseGlobal` service the MCP door
 * (`synap_diagnose`) and the Hub REST door (`POST /api/hub/diagnose`) call — no
 * new aggregation logic lives here. It exists because the browser can only reach
 * tRPC, while `diagnoseGlobal` was previously reachable ONLY via MCP / Hub REST.
 *
 * `global` is USER-floored inside the service (`userVisibleWhere`), aggregating
 * across every workspace the caller can see (the sovereign "whole brain"), and
 * is HONEST-EMPTY by construction. `workspaceId` narrows the floor to one lens.
 *
 * Auth: protectedProcedure — the ctx user is the floor; the client never supplies
 * a userId.
 */

import { z } from "zod";
import {
  eventRepository,
  UNGOVERNED_INSTRUMENTATION_EPOCH,
} from "@synap/database";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { diagnoseGlobal } from "../services/diagnose/index.js";
import {
  agentScorecard,
  allAgentsScorecard,
} from "../services/diagnose/agent-scorecard.js";
import { agentProfile } from "../services/diagnose/agent-profile.js";

export const diagnoseRouter = router({
  /**
   * Whole-pod health — the tRPC counterpart of a no-arg `diagnose({})`. Reuses
   * `diagnoseGlobal` verbatim, so the browser gets the exact same ranked health
   * report as MCP / Hub REST callers.
   */
  global: protectedProcedure
    .input(
      z
        .object({
          /** Narrow the whole-pod floor to a single workspace lens. */
          workspaceId: z.string().nullable().optional(),
          /** Override the "stuck run" age boundary (hours). */
          stuckThresholdHours: z.number().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return diagnoseGlobal({
        userId,
        workspaceId: input?.workspaceId ?? null,
        stuckThresholdHours: input?.stuckThresholdHours,
      });
    }),

  /**
   * The pod-wide agent trust grid — REAL lifetime `count(*) GROUP BY status` per
   * agent-user, user-floored, humans excluded, keyed on stable `agentUserId`.
   * Powers Governance › History. Replaces the browser's old client-side reduce
   * over a fetched proposal page (which was a per-fetch slice, not a total).
   */
  agents: protectedProcedure.query(async ({ ctx }) => {
    const userId = requireUserId(ctx.userId);
    return allAgentsScorecard({ userId });
  }),

  /**
   * One agent's full scorecard (counts + rates + rejection-reason histogram +
   * duplicate rate + daily-cap posture) — the SAME `agentScorecard` service the
   * MCP/Hub doors use, exposed over tRPC for the Agent dashboard.
   */
  agent: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return agentScorecard({ userId, agentId: input.agentId });
    }),

  /**
   * One agent's identity + PROVENANCE (origin, linked-by, pod-wide vs
   * workspace) — powers the Agent dashboard header. Owner-floored.
   */
  agentProfile: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return agentProfile({ userId, agentId: input.agentId });
    }),

  /**
   * The "ungoverned AI writes" blind spot (0231) over tRPC — agent writes that
   * EXECUTED with no proposal at all (`is_agent = true AND proposal_id IS NULL`
   * on the `.completed` event). The browser-native twin of `GET /api/hub/events
   * ?ungoverned=true`, reusing the SAME `eventRepository.searchEvents` predicate
   * and the SAME owner-pinned `userId` scoping (ctx floor, never client-supplied)
   * — one repository fn, two doors, no divergent scoping. HONEST-EMPTY: returns
   * [] when every agent write went through a proposal. Coverage note: accurate
   * for the instrumented (entity) agent path; surfaces that do not agent-attribute
   * their completed events are `is_agent = false` and simply absent, never a false
   * positive.
   */
  ungovernedWrites: protectedProcedure
    .input(
      z
        .object({
          /** Scope to one agent's ungoverned writes. */
          agentUserId: z.string().optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const rows = await eventRepository.searchEvents({
        ungoverned: true,
        userId,
        agentUserId: input?.agentUserId,
        limit: input?.limit ?? 50,
      });
      // The read is floored at the instrumentation epoch (see the constant's
      // docblock) — the caller gets that boundary so the UI can state its scope
      // instead of implying it covers all history.
      const since = UNGOVERNED_INSTRUMENTATION_EPOCH.toISOString();
      const writes = rows.map((e) => ({
        id: e.id,
        agentUserId: e.agentUserId ?? null,
        agentType: e.agentType ?? null,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        action: e.eventType,
        at:
          e.timestamp instanceof Date
            ? e.timestamp.toISOString()
            : String(e.timestamp),
      }));
      return { writes, since };
    }),
});
