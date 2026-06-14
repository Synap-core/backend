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

export const playbookRunsRouter = router({
  /**
   * List all playbook_run rows for a given focus session, most recent first.
   *
   * Security: we verify the session belongs to ctx.userId before returning
   * its runs — a bare `WHERE session_id = ?` would let any authenticated
   * user enumerate runs for sessions they don't own.
   */
  listBySession: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();

      // Verify the session belongs to the calling user before exposing its runs.
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
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
});
