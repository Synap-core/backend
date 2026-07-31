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
import { listRuns, getRun, listRunGroupsPage } from "../services/runs/index.js";
import { listRecentRunsByFlows } from "../services/runs/recent-by-flows.js";

const flowType = z.enum([
  "automation",
  "playbook",
  "capture",
  "capability",
  "session",
  "chat",
]);
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

  /** Runs collapsed to ONE row per flow (automation / playbook), newest-active
   *  first. The counts + latest run are exact over the whole ledger (grouped in
   *  the DB), so a template card can show a true run count. capture/session runs
   *  have no flow and are absent — they stay individual rows via `.list`. */
  groups: protectedProcedure
    .input(
      z.object({
        flowType: z.enum(["automation", "playbook"]).optional(),
        scope: z
          .object({ workspaceId: z.string().uuid().optional() })
          .optional(),
        limit: z.number().min(1).max(100).optional(),
        cursor: z.string().min(1).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return listRunGroupsPage({ userId, ...input });
    }),

  /**
   * Every active execution plus the last N terminal executions for each visible
   * automation/playbook in a bounded batch. The service issues at most one
   * window query per ledger, so process health stays inspectable even when a
   * long-running execution falls behind newer terminal activity.
   */
  recentByFlows: protectedProcedure
    .input(
      z.object({
        flows: z
          .array(
            z.object({
              flowType: z.enum(["automation", "playbook"]),
              flowId: z.string().uuid(),
            })
          )
          .min(1)
          .max(100),
        scope: z
          .object({ workspaceId: z.string().uuid().optional() })
          .optional(),
        perFlowLimit: z.number().int().min(1).max(20).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const histories = await listRecentRunsByFlows({ userId, ...input });
      return { histories };
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
