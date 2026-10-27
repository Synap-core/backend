import { db, proposals, eq, and, or, not, drizzleSql } from "@synap/database";
import { ownAgentUserFilter } from "../agent-identity-service.js";
import { reviewLaterProposalWhere } from "../proposals/proposal-fate.js";

export type PendingReviewState =
  | {
      status: "ok";
      /** The headline: pending proposals NOT in Review later. */
      count: number;
      oldestDays: number;
      oldestId?: string;
      /** Untouched durable proposals out of the headline (Review later). */
      reviewLater: number;
    }
  | { status: "unavailable" };

/**
 * The pending-review backlog: count + oldest, read ONCE here for every door
 * that names the queue (orient's `startHere`, `ask`'s queue answer). Best-effort:
 * a read that hiccups is `unavailable`, never "0 waiting" — orient must not fail
 * for it, and a calm zero would be a wrong answer.
 *
 * MUST match what `synap_list_proposals` returns (the tool the nudge tells the
 * user to call), or the count and the tool disagree. The canonical queue floors
 * by AUTHOR — me OR an agent I created (`proposals-service.ts`) — with a
 * workspaceId only NARROWING. An earlier version floored by workspace
 * MEMBERSHIP instead, which on a multi-user pod counted a teammate's pending
 * proposals for this user (both a wrong count and a small disclosure of their
 * backlog). Floor by author, user-wide, exactly like the tool's default.
 *
 * `count` and `oldest` are aggregated over the SAME floored population as the
 * list: widening the list without widening this would make `oldestDays` a
 * number computed over a different set than the count printed beside it.
 *
 * REVIEW LATER (founder default, 2026-10-26): untouched durable
 * proposals leave the headline after 7 days. `count`, `oldestDays` and
 * `oldestId` are the headline; `reviewLater` counts the rest — through the
 * SAME predicate the needs-you `decisions` count reads
 * (`reviewLaterProposalWhere`), so orient and the badge cannot disagree on
 * which proposals moved.
 */
export async function readPendingReviewState(
  userId: string
): Promise<PendingReviewState> {
  try {
    const pendingFloor = and(
      eq(proposals.status, "pending"),
      or(
        eq(proposals.createdBy, userId),
        ownAgentUserFilter(proposals.agentUserId, userId),
        ownAgentUserFilter(proposals.createdBy, userId)
      )
    );
    // COUNT + MIN in one aggregate row — never load the rows themselves. On a
    // busy pod the pending queue can be large, and orient runs on every session
    // start; a full-row fetch just to count would tax the mandated first call.
    const reviewLater = reviewLaterProposalWhere(new Date());
    const [agg] = await db
      .select({
        count: drizzleSql<number>`(count(*) filter (where not ${reviewLater}))::int`,
        reviewLater: drizzleSql<number>`(count(*) filter (where ${reviewLater}))::int`,
        oldest: drizzleSql<Date | null>`min(${proposals.createdAt}) filter (where not ${reviewLater})`,
      })
      .from(proposals)
      .where(pendingFloor);
    const count = agg?.count ?? 0;
    let oldestId: string | undefined;
    if (count > 0) {
      // The oldest proposal's id, for startHere's review link — one indexed
      // row over the SAME floor as the count. A failed read costs the link
      // only; the count beside it is still true.
      try {
        const [oldestRow] = await db
          .select({ id: proposals.id })
          .from(proposals)
          .where(and(pendingFloor, not(reviewLater)))
          .orderBy(drizzleSql`${proposals.createdAt} asc`)
          .limit(1);
        oldestId = oldestRow?.id;
      } catch {
        // The link only; the count beside it stands.
      }
    }
    return {
      status: "ok",
      count,
      oldestDays:
        count > 0 && agg?.oldest
          ? Math.floor(
              (Date.now() - new Date(agg.oldest).getTime()) / 86_400_000
            )
          : 0,
      ...(oldestId ? { oldestId } : {}),
      reviewLater: agg?.reviewLater ?? 0,
    };
  } catch {
    // Unreadable is its own state in startHere; the legacy top-level
    // `pendingReview` key stays omitted, as before.
    return { status: "unavailable" };
  }
}
