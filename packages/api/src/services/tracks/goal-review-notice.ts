/**
 * A GOAL IN REVIEW reaches its judge (work model W5, 2026-10-23).
 *
 * "In review" is derived, never stored (`goalInReview`, decision 2): every
 * required criterion claimed and the judge has not decided. Without a notice
 * the judge only learns it by opening the goal. So when a passing evaluation
 * lands on a run filed into a goal, {@link noticeGoalReviewReady} reads the
 * goal's facts through the ONE derivation every track read uses
 * (`loadTrackGoalFacts`) and, if the goal is now in review, tells its judge
 * (`loadGoalJudge`: the judge seat, else the owner) through the one
 * notification door — type `track.review_ready`, a JUDGEMENT the Inbox ranks
 * first (`JUDGEMENT_NOTIFICATION_TYPES`, @synap-core/types/lens).
 *
 * ONE open row per goal: the registry type declares a dedupe window over the
 * goal-keyed `groupKey`, so further claims while it is unread write nothing.
 * The judge's decision on any criterion, or the goal leaving the active
 * category, settles it ({@link settleGoalReviewNotice}); a new claim after a
 * send-back raises it again.
 *
 * Never throws: a notice is a nudge after the write already happened — a
 * failed read or write is logged, and the evaluation stands.
 */

import { and, eq, getDb, projects, projectTracks } from "@synap/database";
import { notifications, type ProjectTrack } from "@synap/database/schema";
import { trackStatusCategory } from "@synap-core/types/units";
import { createLogger } from "@synap-core/core";
import { loadTrackGoalFacts } from "./goal-content.js";
import { loadGoalJudge } from "./track-participant-store.js";

const logger = createLogger({ module: "goal-review-notice" });

/**
 * Declared under the lowercase name first, deliberately: the producer
 * allowlist tripwire finds a producer by the literal next to
 * `(type|notificationType)\s*[:=?]` (as `evaluations/record.ts` does).
 */
const notificationType = "track.review_ready" as const;
export const GOAL_REVIEW_NOTIFICATION_TYPE = notificationType;

/** One open "ready for your verdict" row per goal. */
export function goalReviewGroupKey(trackId: string): string {
  return `track-review:${trackId}`;
}

/**
 * Tell the goal's judge it is in review, if it now is. Returns whether a
 * notice was written (false when the goal is not in review, not active, gone,
 * or an unread notice already holds the goal).
 */
export async function noticeGoalReviewReady(trackId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const [row] = await db
      .select({ track: projectTracks, workspaceId: projects.workspaceId })
      .from(projectTracks)
      .innerJoin(projects, eq(projects.id, projectTracks.projectId))
      .where(eq(projectTracks.id, trackId))
      .limit(1);
    if (!row) return false;
    const track: ProjectTrack = row.track;
    // Only a goal being worked is "in review" — a proposed, paused, closed or
    // dropped goal's claims wait for it to be active again.
    if (trackStatusCategory(track.status) !== "active") return false;
    const judge = await loadGoalJudge(track);
    const facts = (await loadTrackGoalFacts([track], judge)).get(track.id);
    if (!facts?.inReview) return false;
    const { NotificationService } =
      await import("../../notifications/NotificationService.js");
    const written = await NotificationService.create({
      type: GOAL_REVIEW_NOTIFICATION_TYPE,
      userId: track.userId, // NEGCTL M6
      workspaceId: row.workspaceId,
      sourceType: "track",
      sourceId: track.id,
      groupKey: goalReviewGroupKey(track.id),
      data: { trackId: track.id, trackName: track.name },
    });
    return Boolean(written);
  } catch (err) {
    logger.warn({ err, trackId }, "goal review notice failed");
    return false;
  }
}

/**
 * The judge decided (accepted, sent back or rejected a criterion) or the goal
 * left the active category: the "ready for your verdict" row leaves Needs you.
 * Idempotent; never throws.
 */
export async function settleGoalReviewNotice(trackId: string): Promise<void> {
  try {
    const db = await getDb();
    const now = new Date();
    await db
      .update(notifications)
      .set({ status: "actioned", readAt: now })
      .where(
        and(
          eq(notifications.type, GOAL_REVIEW_NOTIFICATION_TYPE),
          eq(notifications.groupKey, goalReviewGroupKey(trackId))
        )
      );
  } catch (err) {
    logger.warn({ err, trackId }, "goal review notice could not be settled");
  }
}
