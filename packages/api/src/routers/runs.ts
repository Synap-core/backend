/**
 * Runs Router — the unified cross-flow run feed + per-run detail.
 *
 * ONE read surface over the pod's several run ledgers (automation / playbook /
 * capture / session), each mapped to a `UnifiedRun`. This is what makes "open a
 * flow → see its runs → open a run → see what happened" work the same way for
 * every flow, and it's the door the AI diagnose path reads (Wave A of the
 * runs-substrate consolidation).
 *
 * Auth: protectedProcedure, USER-floored inside the service via `userVisibleWhere`
 * — the same access predicate `proposals.list` / `activity.summary` use.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { listRuns, getRun } from "../services/runs/index.js";

const flowType = z.enum(["automation", "playbook", "capture", "session"]);
const runStatus = z.enum([
  "running",
  "completed",
  "failed",
  "proposed",
  "cancelled",
  "skipped",
]);

export const runsRouter = router({
  /** Newest-first run feed across flows (or one flow via `flowType`/`flowId`).
   *  `scope` narrows to a workspace / project / entity lens at the DB (within the
   *  user floor) — the Activity telescope's altitude filters. */
  list: protectedProcedure
    .input(
      z.object({
        flowType: flowType.optional(),
        flowId: z.string().uuid().optional(),
        scope: z
          .object({
            workspaceId: z.string().uuid().optional(),
            projectId: z.string().uuid().optional(),
            subjectEntityId: z.string().uuid().optional(),
          })
          .optional(),
        /** Filter to one lifecycle status, pushed down per ledger (server-side). */
        status: runStatus.optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const runs = await listRuns({ userId, ...input });
      return { runs };
    }),

  /** One run + its flow-agnostic activity timeline. */
  get: protectedProcedure
    .input(z.object({ flowType, id: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const detail = await getRun({
        userId,
        flowType: input.flowType,
        id: input.id,
      });
      return detail;
    }),
});
