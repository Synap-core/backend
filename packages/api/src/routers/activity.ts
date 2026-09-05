/**
 * Activity Router — per-unit aggregates for the Activity telescope.
 *
 * `summary` returns the "needs attention" count (pending proposals) for the unit
 * cards shown at a given altitude:
 *   - no projectId → pod scope: one count per PROJECT (proposals.projectId)
 *   - projectId    → project scope: one count per SESSION (proposals.sessionId)
 *
 * Cheap + migration-free: proposals already carry indexed `projectId` (migration
 * 0138) and `sessionId` (0119) columns, so this is a single GROUP BY. Per-unit
 * run/event totals and egress ("left pod") are DEFERRED — the events table has
 * no project/session column and egress has no per-unit attribution yet (see the
 * Activity spec). Only the count that is both cheap and high-value ships here.
 *
 * Auth: protectedProcedure, USER-floored via `userVisibleWhere` (the SAME access
 * predicate `proposals.list` uses) so no other workspace's pending queue leaks.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { proposalUserFloor } from "./proposals/scope-conditions.js";
import { db, proposals, and, eq, isNotNull, count } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";

export const activityRouter = router({
  /**
   * Per-unit "needs attention" counts (pending proposals). Returns one entry per
   * unit that has ≥1 pending proposal; units with none are simply absent (the
   * caller treats a missing id as 0). `unit` tells the caller how to key `counts`.
   */
  summary: protectedProcedure
    .input(
      z.object({
        /** Set → count per SESSION within this project; omit → count per PROJECT. */
        projectId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // The access floor — the SAME predicate `proposals.list` builds
      // (`proposalUserFloor`), so this attention count and the queue it
      // summarizes can never disagree. It is LENS ∪ OWNERSHIP: the lens alone
      // dropped the caller's OWN pending rows whose workspace is orphaned or
      // unjoinable, which would make the badge under-report its own list.
      // Widens what is COUNTED, never what may be done — approve/reject stay
      // gated by `canReviewProposal`.
      const visible = proposalUserFloor(userId);
      const pending = eq(proposals.status, ProposalStatus.PENDING);

      if (input.projectId) {
        // Project scope → needs-attention per SESSION under this project.
        const rows = await db
          .select({ id: proposals.sessionId, needsAttention: count() })
          .from(proposals)
          .where(
            and(
              visible,
              pending,
              eq(proposals.projectId, input.projectId),
              isNotNull(proposals.sessionId)
            )
          )
          .groupBy(proposals.sessionId);
        return {
          unit: "session" as const,
          counts: rows
            .filter(
              (r): r is { id: string; needsAttention: number } => r.id != null
            )
            .map((r) => ({
              id: r.id,
              needsAttention: Number(r.needsAttention),
            })),
        };
      }

      // Pod scope → needs-attention per PROJECT.
      const rows = await db
        .select({ id: proposals.projectId, needsAttention: count() })
        .from(proposals)
        .where(and(visible, pending, isNotNull(proposals.projectId)))
        .groupBy(proposals.projectId);
      return {
        unit: "project" as const,
        counts: rows
          .filter(
            (r): r is { id: string; needsAttention: number } => r.id != null
          )
          .map((r) => ({ id: r.id, needsAttention: Number(r.needsAttention) })),
      };
    }),
});
