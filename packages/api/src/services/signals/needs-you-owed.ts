/**
 * THE needs-you OWED predicate — one function for the count and "asks you".
 *
 * An owed slot needs YOU when it sits on one of the caller's OWN sessions (the
 * owner floor `listOwedSlots` applies) and that session is not an undecided
 * agent draft (`excludeDrafts`: a draft never counts as needs-you, founder
 * decision). The signals union's owed half counts `listNeedsYouOwed`; the
 * homes ask `asksYouSessionIds` which of their open sessions hold such a slot
 * — so a home's "asks you" can never disagree with the needs-you count
 * (homes review Q-S3: a draft, or another person's session a roster reader
 * sees, used to say "waits on you" while the count said 0).
 *
 * A service, not a router export: `services/lifecycle/homes.ts` reads it
 * without importing a router.
 */
import {
  listOwedSlots,
  type ListOwedSlotsParams,
} from "../focus-sessions/owed-outputs.js";
import { resolveScope } from "../../utils/scope-filter.js";

/** The owed half of needs-you: the owner floor, drafts never counted. */
export function listNeedsYouOwed(
  scope: Omit<ListOwedSlotsParams, "excludeDrafts" | "onlyDrafts">
) {
  return listOwedSlots({ ...scope, excludeDrafts: true });
}

/**
 * Which of `sessionIds` ASK YOU — hold a slot the needs-you count counts, at
 * the full floor (no workspace lens: the explicit `[]` suppresses the
 * active-workspace header default, as `floorLens` does for the union). A
 * failed read THROWS (the caller decides what unknown means).
 */
export async function asksYouSessionIds(
  userId: string,
  sessionIds: readonly string[]
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Set();
  const slots = await listNeedsYouOwed({
    userId,
    scope: resolveScope({}, { workspaceId: [] }),
    sessionIds: ids,
    // Bounded by `sessionIds`; never cut a session's slots short.
    limit: Number.MAX_SAFE_INTEGER,
  });
  return new Set(slots.map((s) => s.sessionId));
}
