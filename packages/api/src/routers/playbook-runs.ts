/**
 * Playbook Runs tRPC Router — read-only queries for the run ledger.
 *
 * A playbook_run is one execution instance of a Playbook, created by
 * `runPlaybook` and updated as the executor reports back. This router
 * exposes the minimum surface needed for the browser to display run
 * history attached to a focus session.
 *
 * Auth: protectedProcedure (Kratos session cookie). Scoping mirrors the
 * focus-sessions router: runs are filtered to the authenticated user's
 * sessions by joining via sessionId → focus_sessions.userId = ctx.userId.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx §4.3-4.4
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  getDb,
  eq,
  and,
  desc,
  playbookRuns,
  focusSessions,
} from "@synap/database";
import {
  rosterReadFor,
  sessionReadableWhere,
} from "../access/session-visibility.js";
import { cancelRun } from "../services/agent-dispatch/cancel-run.js";

export const playbookRunsRouter = router({
  /**
   * List all playbook_run rows for a given focus session, most recent first.
   *
   * Security: we verify the caller may READ the session
   * (`sessionReadableWhere`) before returning its runs — a bare
   * `WHERE session_id = ?` would let any authenticated user enumerate runs for
   * sessions they cannot see.
   */
  listBySession: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();

      // Verify the caller may READ the session (owner, or a human seat on
      // its room's roster — decision C) before exposing its runs.
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          sessionReadableWhere({
            userId: ctx.userId,
            roster: rosterReadFor(ctx),
          })
        ),
      });

      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }

      return db
        .select()
        .from(playbookRuns)
        .where(eq(playbookRuns.sessionId, input.sessionId))
        .orderBy(desc(playbookRuns.startedAt));
    }),

  /**
   * Cancel a live run — and its external agent's task when the binding can
   * cancel. The SAME logic as Hub `POST /runs/:runId/cancel` (`cancelRun`,
   * services/agent-dispatch/cancel-run.ts): one function, two transports.
   *
   * HUMAN-ONLY, and the session OWNER only: stopping work is the person's call
   * (a roster member reads, never writes — decision C). An agent key is refused.
   */
  cancelRun: protectedProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.agentUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only a person can cancel a run — an agent key cannot.",
        });
      }
      const db = await getDb();
      const [run] = await db
        .select({ id: playbookRuns.id, sessionId: playbookRuns.sessionId })
        .from(playbookRuns)
        .where(eq(playbookRuns.id, input.runId))
        .limit(1);
      const session = run?.sessionId
        ? await db.query.focusSessions.findFirst({
            where: eq(focusSessions.id, run.sessionId),
            columns: { userId: true },
          })
        : null;
      // A run that is not yours reads exactly like a missing one (no oracle).
      if (!run || !session || session.userId !== ctx.userId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      const out = await cancelRun({ runId: run.id, userId: ctx.userId });
      if (out.status === "not_found") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      if (out.status === "not_live") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Run is ${out.runStatus}, not running — nothing to cancel`,
        });
      }
      if (out.status === "cancel_failed") {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `The agent's task could not be cancelled: ${out.message}`,
        });
      }
      return {
        runId: run.id,
        status: "cancelled" as const,
        externalCancelled: out.externalCancelled,
        note: out.note ?? null,
      };
    }),
});
