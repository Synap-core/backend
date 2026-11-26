/**
 * The goal loop's EVENT seams (work model W4) — the moments a goal may need
 * its next run, read off events that already exist:
 *
 *   · `focus_session.closed` — a run ended; if it was filed into a goal, that
 *     goal looks again (the close door, `complete-session.ts`, is the only
 *     emitter — `close-event.ts`);
 *   · `track.update` — the goal's status moved (`applyTrackStatus`) or a
 *     person switched its loop on (`applyTrackDirection`).
 *
 * The reactor only routes: the goal id → `runGoalLoop`, then the pathway
 * re-plan beside it (`runPathwayReplan`, P9: a step of a pathway that ended
 * without delivering), each re-reading every fact itself (a replayed event
 * can never make either propose twice past its one-pending rule). The hourly re-check is the reaper's tick
 * (`sweepGoalLoops`), not this file.
 *
 * NEVER SILENTLY SWALLOWS: `emitSideEffects` isolates a failing reactor; a
 * failure here is logged with the goal it was about.
 */

import { createLogger } from "@synap-core/core";
import { db, eq, focusSessions } from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import {
  FOCUS_SESSION_CLOSE_ACTION,
  FOCUS_SESSION_SUBJECT_TYPE,
} from "../focus-sessions/close-event.js";
import { runGoalLoop } from "./goal-loop.js";
import { runPathwayReplan } from "./pathway-replan.js";

const logger = createLogger({ module: "goal-loop-reactor" });

export const goalLoopReactor: Reactor = {
  id: "goal-loop",
  match: (payload) =>
    (payload.subjectType === FOCUS_SESSION_SUBJECT_TYPE &&
      payload.action === FOCUS_SESSION_CLOSE_ACTION) ||
    (payload.subjectType === "track" && payload.action === "update"),
  async handler(payload) {
    let goalId: string | null = null;
    try {
      if (payload.subjectType === "track") {
        goalId =
          (payload.data?.trackId as string | undefined) ??
          payload.subjectId ??
          null;
      } else {
        const sessionId =
          (payload.data?.sessionId as string | undefined) ?? payload.subjectId;
        if (!sessionId) return;
        // The ROW says which goal the run was filed into — not the payload.
        const [run] = await db
          .select({ trackId: focusSessions.trackId })
          .from(focusSessions)
          .where(eq(focusSessions.id, sessionId))
          .limit(1);
        goalId = run?.trackId ?? null;
      }
      if (!goalId) return;
      const result = await runGoalLoop(goalId);
      if (result.status === "proposed") {
        logger.info(
          { goalId, proposalId: result.proposalId, carry: result.carry },
          "goal loop proposed the next run"
        );
      }
    } catch (error) {
      logger.error({ error, goalId }, "goal loop failed on an event");
    }
    // The pathway re-plan, beside it (P9): its own failure is its own.
    if (!goalId) return;
    try {
      // It logs its own filing (its audit line), whoever called it.
      await runPathwayReplan(goalId);
    } catch (error) {
      logger.error({ error, goalId }, "pathway re-plan failed on an event");
    }
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerGoalLoopReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(goalLoopReactor);
  logger.info("Registered goal loop reactor");
}
