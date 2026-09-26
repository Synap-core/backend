/**
 * `viewerRole` on session READ rows (founder decision C, 2026-09-25).
 *
 * A session is readable by its owner and by the human roster of its room
 * (`access/session-visibility.ts`). Members are READ-ONLY: every write door
 * keeps the owner floor. This projection tells a UI which one it is looking at
 * so it can hide the write verbs — `"owner"` or `"member"`, derived from the
 * row, never stored.
 *
 * It also keeps a member's NEEDS-YOU honest. `unitFacts` (the facts
 * `needsYouReason` reduces over) are OWNER-directed by construction: owed
 * slots are handed to the session's owner, `ready_to_close` is the owner's
 * acceptance, and the pending-decision count is every proposal filed under the
 * session. None of that is owed BY a member, so on a member row:
 *   - `owedFromYou` is 0 — nothing is owed from the member (a claim, not a
 *     failed read: owed slots are never handed to a roster seat today);
 *   - `awaitingReview` is false — closing is an owner write;
 *   - `pendingDecisions` is 0 — zero decisions owed BY the member through this
 *     row. Review rights are workspace roles and reach a member through
 *     `proposals.groups` (the decision tray), never through a session row.
 * So a shared session can never count toward the member's needs-you tally.
 */
import {
  sessionViewerRole,
  type SessionViewerRole,
} from "../../access/session-visibility.js";
import type { SessionUnitCounts } from "./session-path-sections.js";

export type { SessionViewerRole };

export function withViewerRole<
  R extends { userId: string; unitFacts?: SessionUnitCounts },
>(row: R, viewerId: string): R & { viewerRole: SessionViewerRole } {
  const viewerRole = sessionViewerRole(row, viewerId);
  if (viewerRole === "owner" || !row.unitFacts) return { ...row, viewerRole };
  return {
    ...row,
    viewerRole,
    unitFacts: {
      ...row.unitFacts,
      owedFromYou: 0,
      awaitingReview: false,
      pendingDecisions: 0,
    },
  };
}
