/**
 * Workflows Router — the DERIVED workflow-place read door (WORKFLOW-AS-PLACE, D1).
 *
 * A "workflow" is an automation OR a playbook. This router exposes ONE
 * observability aggregate per workflow (`place`) + its event feed (`placeFeed`)
 * — runs, sessions, channels, produced results, and attributed proposals, all
 * derived from keys already on the runtime tables (no new access lens, no
 * migration).
 *
 * Auth: protectedProcedure, USER-floored inside the service via `userVisibleWhere`.
 * `place`/`placeFeed` are DELIBERATELY lens-free single-workflow reads — they
 * take {kind, id} and floor by the user; they do NOT accept or apply a
 * workspace/project lens (single-fetch-lens-free tripwire).
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import {
  getWorkflowPlace,
  getWorkflowPlaceFeed,
} from "../services/workflow-place/index.js";

const workflowKind = z.enum(["automation", "playbook"]);

export const workflowsRouter = router({
  /** One workflow's place: definition + runs + sessions + channels + results +
   *  proposals. USER-floored; null when the workflow is not visible. */
  place: protectedProcedure
    .input(z.object({ kind: workflowKind, id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const place = await getWorkflowPlace({
        kind: input.kind,
        id: input.id,
        userId,
      });
      return place;
    }),

  /** The workflow's per-workflow event feed (focus-session events), newest-first,
   *  cursor-paginated. USER-floored via the session-visibility derivation. */
  placeFeed: protectedProcedure
    .input(
      z.object({
        kind: workflowKind,
        id: z.string().uuid(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return getWorkflowPlaceFeed({
        kind: input.kind,
        id: input.id,
        userId,
        cursor: input.cursor,
        limit: input.limit,
      });
    }),
});
