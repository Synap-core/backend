/**
 * WHAT A GOAL LEAVES BEHIND WHEN IT ENDS (review fixes, 2026-10-24) — the
 * one place the status door (`applyTrackStatus`) settles a goal that was
 * closed or dropped, so nothing about it keeps asking anyone for anything:
 *
 *   · its delegates' commitments (layers.md): on a CLOSE an `accepted`
 *     commitment is `done` — the goal it served was delivered. A drop marks
 *     nothing done (nothing was delivered); either way an ended goal's open
 *     commitments stop measuring silence (`loadTrackParticipantViews`), so
 *     "Silent 3 d" never shows on a closed goal;
 *   · its notifications (code.md): an escalated "impossible" report
 *     (`track.report_unacknowledged`) and a loop stop (`track.loop_stopped`)
 *     are settled — the judge's items are settled by `refreshGoalJudgements`;
 *   · its loop's pending proposals (plan.md): EXPIRED — the moment passed,
 *     nobody decided — with their bell rows (`markProposalNotificationsActioned`).
 *
 * Never throws: the goal already ended; a failure is logged.
 */

import {
  and,
  drizzleSql,
  eq,
  getDb,
  like,
  notifications,
  proposals,
  trackParticipants,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { trackReportGroupKeyPrefix } from "@synap-core/types/units";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";
import { GOAL_LOOP_AUTHOR } from "../focus-sessions/create-session.js";
import { GOAL_LOOP_STOPPED_TYPE } from "./goal-loop.js";

const logger = createLogger({ module: "goal-end" });

export async function settleEndedGoal(input: {
  trackId: string;
  ending: "done" | "lost";
  /** The person who closed or dropped it (the approver on a replay). */
  userId: string;
}): Promise<void> {
  const { trackId, ending, userId } = input;
  try {
    const db = await getDb();
    const now = new Date();
    if (ending === "done") {
      await db
        .update(trackParticipants)
        .set({ commitmentState: "done", decidedBy: userId, decidedAt: now })
        .where(
          and(
            eq(trackParticipants.trackId, trackId),
            eq(trackParticipants.role, "delegate"),
            eq(trackParticipants.commitmentState, "accepted")
          )
        );
    }

    const participantIds = (
      await db
        .select({ id: trackParticipants.id })
        .from(trackParticipants)
        .where(eq(trackParticipants.trackId, trackId))
    ).map((r) => r.id);
    if (participantIds.length > 0) {
      await db
        .update(notifications)
        .set({ status: "actioned", readAt: now })
        .where(
          and(
            eq(notifications.type, "track.report_unacknowledged"),
            drizzleSql`(${drizzleSql.join(
              participantIds.map(
                (id) =>
                  drizzleSql`${notifications.groupKey} LIKE ${`${trackReportGroupKeyPrefix(id)}%`}`
              ),
              drizzleSql` OR `
            )})`
          )
        );
    }
    await db
      .update(notifications)
      .set({ status: "actioned", readAt: now })
      .where(
        and(
          eq(notifications.type, GOAL_LOOP_STOPPED_TYPE),
          like(notifications.groupKey, `${GOAL_LOOP_STOPPED_TYPE}:${trackId}:%`)
        )
      );

    const expired = await db
      .update(proposals)
      .set({ status: ProposalStatus.EXPIRED, updatedAt: now })
      .where(
        and(
          eq(proposals.status, ProposalStatus.PENDING),
          eq(proposals.createdBy, GOAL_LOOP_AUTHOR),
          drizzleSql`${proposals.data}->'data'->>'goalLoopOf' = ${trackId}`
        )
      )
      .returning({ id: proposals.id });
    markProposalNotificationsActioned(expired.map((p) => p.id));
  } catch (err) {
    logger.error({ err, trackId }, "an ended goal could not be settled");
  }
}
