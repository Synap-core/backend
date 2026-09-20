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

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { listRuns, getRun, listRunGroupsPage } from "../services/runs/index.js";
import { listRecentRunsByFlows } from "../services/runs/recent-by-flows.js";

/**
 * Must mirror the domain type `FlowType` (`services/runs/types.ts`) exactly.
 *
 * `agent_write` was added to the domain type — and to the unified feed, and to
 * `getRun`, which carries a complete `agent_write` branch (`services/runs/
 * index.ts:1476`) that resolves the run and joins its correlationId events — but
 * this input enum was never widened to match. So the runs feed listed
 * agent-write runs the detail door then refused to fetch: click one and it 400s.
 * The service could always serve it; only the door was narrower than the room
 * behind it.
 *
 * If you add a member to `FlowType`, add it here in the same change.
 */
const flowType = z.enum([
  "automation",
  "playbook",
  "capture",
  "capability",
  "session",
  "chat",
  "agent_write",
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
            /**
             * SESSION lens — "every run that happened inside this focus
             * session". Covers the `capability` ledger only; every other
             * ledger carries no session key and is EXCLUDED rather than
             * returned unfiltered (see `RunScope.sessionId`). Combining it
             * with `projectId` THROWS by design — a session already pins its
             * project, and the pair would silently drop every direct run.
             */
            sessionId: z.string().uuid().optional(),
          })
          .optional(),
        /** Filter to one lifecycle status, pushed down per ledger (server-side). */
        status: runStatus.optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // INCOHERENT SCOPE is a CALLER error, so it must read as one. `listRuns`
      // throws on `sessionId` + `projectId` (a session lens under a project
      // scope would silently drop every direct run), but a bare service throw
      // surfaces as INTERNAL_SERVER_ERROR — telling the caller "we broke" when
      // the truth is "you asked for something incoherent". Same correction as
      // the repair-error 400 on the capability-execute door.
      if (input.scope?.sessionId && input.scope?.projectId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "scope.sessionId and scope.projectId cannot be combined — a session already pins its project, and the pair would silently drop every direct capability run. Pass one or the other.",
        });
      }
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
