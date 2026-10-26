/**
 * A GOAL'S JUDGEMENTS reach its judge (work model W5, 2026-10-23; review
 * fixes F1 and "each claim on its own", 2026-10-24).
 *
 * Two kinds of item wait on the goal's judge (`loadGoalJudge`: the judge
 * seat, else the owner), both JUDGEMENTS the Inbox ranks first
 * (`JUDGEMENT_NOTIFICATION_TYPES`, @synap-core/types/lens):
 *
 *   · `track.criterion_claimed` — ONE per claimed criterion: a run passed it
 *     and it waits on the judge's acceptance, whether or not the whole goal
 *     is in review yet (groupKey per goal and criterion);
 *   · `track.review_ready` — the goal is IN REVIEW (`goalInReview`: every
 *     required criterion met or claimed, one at least claimed): "ready for
 *     your verdict". Never for an OPERATION: it is assessed per period and
 *     ends retired, a passing week is not a verdict to give (R6).
 *
 * {@link refreshGoalJudgements} is the ONE function that raises and settles
 * them, from the goal's facts read through the derivation every track read
 * uses (`loadTrackGoalFacts`). Called after a passing evaluation on a run of
 * the goal, after each of the judge's decisions, and when the judge changes:
 *   · a claim that is no longer claimed (accepted, sent back, regressed) —
 *     its item is settled; a new claim raises it again;
 *   · the review item is settled only when NO claimed criterion is left —
 *     never on a single decision while other claims still wait (F1);
 *   · items addressed to someone who is no longer the judge are settled, and
 *     the new judge is told.
 * A goal leaving the active category settles all of them
 * ({@link settleGoalJudgements}).
 *
 * The notification door holds ONE open row per person and groupKey (each
 * type declares a dedupe window), so a refresh that finds nothing new writes
 * nothing. Never throws: a notice is a nudge after the write already
 * happened — a failure is logged, and the write stands.
 */

import {
  and,
  eq,
  getDb,
  inArray,
  like,
  ne,
  notInArray,
  or,
  projects,
  projectTracks,
} from "@synap/database";
import { notifications, type ProjectTrack } from "@synap/database/schema";
import {
  goalJudge,
  goalOwner,
  isTrackVerdict,
  trackStatusCategory,
} from "@synap-core/types/units";
import { resolveTrackVerdictLabel } from "@synap-core/types/vocabulary";
import { createLogger } from "@synap-core/core";
import { loadTrackGoalFacts } from "./goal-content.js";
import {
  goalParticipantRows,
  loadGoalJudge,
  personName,
} from "./track-participant-store.js";

const logger = createLogger({ module: "goal-review-notice" });

/**
 * Declared under the lowercase name first, deliberately: the producer
 * allowlist tripwire finds a producer by the literal next to
 * `(type|notificationType)\s*[:=?]` (as `evaluations/record.ts` does).
 */
const notificationType = "track.review_ready" as const;
export const GOAL_REVIEW_NOTIFICATION_TYPE = notificationType;
export const GOAL_CLAIM_NOTIFICATION_TYPE = "track.criterion_claimed";

/** One open "ready for your verdict" row per goal. */
export function goalReviewGroupKey(trackId: string): string {
  return `track-review:${trackId}`;
}

/** One open "a claim waits on you" row per goal and criterion. */
export function goalClaimGroupKeyPrefix(trackId: string): string {
  return `track-claim:${trackId}:`;
}
export function goalClaimGroupKey(trackId: string, key: string): string {
  return `${goalClaimGroupKeyPrefix(trackId)}${key}`;
}

/** What one refresh did — for tests and logs. */
export interface GoalJudgementsRefresh {
  /** The criteria told about now (a claim item raised or still held). */
  claimed: string[];
  /** Whether the goal is in review and its judge holds the review item. */
  inReview: boolean;
}

/**
 * Raise and settle the goal's judgement items so they say what is true now
 * (see the file header). Returns what it found; `null` when the goal is gone
 * or the refresh failed (logged).
 */
export async function refreshGoalJudgements(
  trackId: string
): Promise<GoalJudgementsRefresh | null> {
  try {
    const db = await getDb();
    const [row] = await db
      .select({ track: projectTracks, workspaceId: projects.workspaceId })
      .from(projectTracks)
      .innerJoin(projects, eq(projects.id, projectTracks.projectId))
      .where(eq(projectTracks.id, trackId))
      .limit(1);
    if (!row) return null;
    const track: ProjectTrack = row.track;
    // Only a goal being worked waits on a judgement — a proposed, paused,
    // closed or dropped goal's claims wait for it to be active again.
    if (trackStatusCategory(track.status) !== "active") {
      await settleGoalJudgements(track.id);
      return { claimed: [], inReview: false };
    }
    const judge = await loadGoalJudge(track);
    const facts = (await loadTrackGoalFacts([track], judge)).get(track.id);
    if (!facts) return null;
    const claimed = facts.criteria.filter((c) => c.mark === "claimed");
    const claimedKeys = claimed.map((c) => c.key);

    // Settle what no longer holds: a claim no longer claimed, and anything
    // addressed to a former judge.
    await db
      .update(notifications)
      .set({ status: "actioned", readAt: new Date() })
      .where(
        and(
          eq(notifications.type, GOAL_CLAIM_NOTIFICATION_TYPE),
          like(notifications.groupKey, `${goalClaimGroupKeyPrefix(track.id)}%`),
          ne(notifications.status, "actioned"),
          claimedKeys.length > 0
            ? or(
                notInArray(
                  notifications.groupKey,
                  claimedKeys.map((k) => goalClaimGroupKey(track.id, k))
                ),
                ne(notifications.userId, judge)
              )
            : undefined
        )
      );
    // The review item leaves only when NO claim is left (F1) — or at once on
    // an operation, which is never "ready for your verdict" (R6); a former
    // judge's leaves too.
    const review = facts.inReview && track.workKind !== "operation";
    if (claimedKeys.length === 0 || track.workKind === "operation") {
      await settleByType(track.id, GOAL_REVIEW_NOTIFICATION_TYPE);
    } else {
      await db
        .update(notifications)
        .set({ status: "actioned", readAt: new Date() })
        .where(
          and(
            eq(notifications.type, GOAL_REVIEW_NOTIFICATION_TYPE),
            eq(notifications.groupKey, goalReviewGroupKey(track.id)),
            ne(notifications.status, "actioned"),
            ne(notifications.userId, judge)
          )
        );
    }

    // What the judge still holds (unread, read, snoozed or dismissed) is not
    // raised again: the door dedupes only UNREAD rows, so a claim the judge
    // has read would otherwise come back as a second row on every later grade.
    const held = new Set(
      (
        await db
          .select({ groupKey: notifications.groupKey })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, judge),
              eq(notifications.sourceId, track.id),
              inArray(notifications.type, [
                GOAL_CLAIM_NOTIFICATION_TYPE,
                GOAL_REVIEW_NOTIFICATION_TYPE,
              ]),
              inArray(notifications.status, [
                "unread",
                "read",
                "snoozed",
                "dismissed",
              ])
            )
          )
      ).flatMap((n) => (n.groupKey ? [n.groupKey] : []))
    );

    const { NotificationService } =
      await import("../../notifications/NotificationService.js");
    for (const c of claimed) {
      if (held.has(goalClaimGroupKey(track.id, c.key))) continue;
      await NotificationService.create({
        type: "track.criterion_claimed",
        userId: judge,
        workspaceId: row.workspaceId,
        sourceType: "track",
        sourceId: track.id,
        groupKey: goalClaimGroupKey(track.id, c.key),
        data: {
          trackId: track.id,
          trackName: track.name,
          criterionKey: c.key,
          criterionStatement: c.statement,
          claimedBy: c.claim?.byName ?? "A run",
        },
      });
    }
    if (review && !held.has(goalReviewGroupKey(track.id))) {
      await NotificationService.create({
        type: GOAL_REVIEW_NOTIFICATION_TYPE,
        userId: judge,
        workspaceId: row.workspaceId,
        sourceType: "track",
        sourceId: track.id,
        groupKey: goalReviewGroupKey(track.id),
        data: { trackId: track.id, trackName: track.name },
      });
    }
    return { claimed: claimedKeys, inReview: review };
  } catch (err) {
    logger.warn({ err, trackId }, "goal judgements could not be refreshed");
    return null;
  }
}

async function settleByType(trackId: string, type: string): Promise<void> {
  const db = await getDb();
  await db
    .update(notifications)
    .set({ status: "actioned", readAt: new Date() })
    .where(
      and(
        eq(notifications.type, type),
        type === GOAL_REVIEW_NOTIFICATION_TYPE
          ? eq(notifications.groupKey, goalReviewGroupKey(trackId))
          : like(
              notifications.groupKey,
              `${goalClaimGroupKeyPrefix(trackId)}%`
            ),
        ne(notifications.status, "actioned")
      )
    );
}

/**
 * The goal left the active category (closed, dropped, paused, back to being
 * shaped): every judgement item about its claims and its review leaves Needs
 * you. Idempotent; never throws.
 */
export async function settleGoalJudgements(trackId: string): Promise<void> {
  try {
    await settleByType(trackId, GOAL_REVIEW_NOTIFICATION_TYPE);
    await settleByType(trackId, GOAL_CLAIM_NOTIFICATION_TYPE);
  } catch (err) {
    logger.warn({ err, trackId }, "goal judgements could not be settled");
  }
}

export const GOAL_END_PROPOSED_NOTIFICATION_TYPE = "track.close_proposed";

/**
 * An agent PROPOSED to end a goal (code-core F12): a close waits on the
 * goal's JUDGE, a drop on its owner or judge — the only people whose approval
 * applies (`assertGoalEnder`). The proposal itself reaches every reviewer of
 * the space; this puts it in the RIGHT person's Needs you as a judgement.
 * `sourceType: "proposal"`: deciding the proposal (approve, reject, expire)
 * settles the row through the one door (`markProposalNotificationsActioned`).
 * Never throws: the proposal is already filed.
 */
export async function noticeGoalEndProposed(input: {
  track: Pick<ProjectTrack, "id" | "name" | "userId">;
  workspaceId: string | null;
  proposalId: string;
  to: string;
  verdict: string | null;
  proposerUserId: string;
}): Promise<number> {
  try {
    const category = trackStatusCategory(input.to);
    if (category !== "done" && category !== "lost") return 0;
    const rows = await goalParticipantRows(input.track.id);
    const judge = goalJudge(rows, input.track);
    const recipients =
      category === "done"
        ? [judge]
        : [...new Set([goalOwner(rows, input.track), judge])];
    const proposerName = (await personName(input.proposerUserId)) ?? "An agent";
    const { NotificationService } =
      await import("../../notifications/NotificationService.js");
    let written = 0;
    for (const userId of recipients) {
      const id = await NotificationService.create({
        // The literal, for the producer allowlist's source scan.
        type: "track.close_proposed",
        userId,
        workspaceId: input.workspaceId,
        sourceType: "proposal",
        sourceId: input.proposalId,
        groupKey: `track-end:${input.proposalId}`,
        data: {
          trackId: input.track.id,
          trackName: input.track.name,
          proposerName,
          endingVerb: category === "done" ? "close" : "drop",
          verdictLabel: isTrackVerdict(input.verdict)
            ? resolveTrackVerdictLabel(input.verdict)
            : "none given",
        },
      });
      if (id) written++;
    }
    return written;
  } catch (err) {
    logger.warn(
      { err, trackId: input.track.id, proposalId: input.proposalId },
      "goal end proposal notice failed"
    );
    return 0;
  }
}
