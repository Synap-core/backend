import { db, proposals, eq, and, or, drizzleSql } from "@synap/database";
import { ownAgentUserFilter } from "../agent-identity-service.js";

export type PendingReviewState =
  | { status: "ok"; count: number; oldestDays: number; oldestId?: string }
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
    const [agg] = await db
      .select({
        count: drizzleSql<number>`count(*)::int`,
        oldest: drizzleSql<Date | null>`min(${proposals.createdAt})`,
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
          .where(pendingFloor)
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
    };
  } catch {
    // Unreadable is its own state in startHere; the legacy top-level
    // `pendingReview` key stays omitted, as before.
    return { status: "unavailable" };
  }
}
