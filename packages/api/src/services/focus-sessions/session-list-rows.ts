/**
 * The focus-session LIST read body — the query, the count and the row
 * projection every session list door shares.
 *
 * Lifted out of `routers/focus-sessions.ts` when a second door needed it:
 * `focusSessions.graph` (`work-graph.ts`) reads the same population through
 * the same WHERE (`sessionListConditions`) and projects its nodes through the
 * same `projectSessionRows`, so a graph node and a list row can never disagree
 * about which sessions match or what a row carries. A service cannot import a
 * router, so the shared body lives here.
 */

import { and, count, db, desc, focusSessions, inArray } from "@synap/database";
import type { FocusSession } from "@synap/database/schema";
import type { SessionActivityLive } from "@synap-core/types/run-activity";
import { attachParentSessionIds } from "./parent-lineage.js";
import {
  sessionListConditions,
  type SessionListQuery,
} from "./session-list-conditions.js";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import { attachTriage } from "./triage.js";
import { attachSessionKind } from "./session-kind.js";
import { attachSessionParticipants } from "./participants.js";
import { requireUserId } from "../../utils/user-scoped.js";
import {
  loadSessionLiveness,
  type LivenessReader,
} from "../runs/session-liveness.js";

/**
 * THE one query body for the focus-sessions read door. focus_sessions is
 * user-owned (`userId`), so the floor is `eq(userId)` — every door starts there.
 * The lenses then only NARROW within the user's own rows:
 *   - workspace lens: `null` → pod-personal (workspaceId IS NULL); `"<id>"` →
 *     that workspace; `string[]` (non-empty) → that SET; `undefined`/`[]` → no
 *     narrow (the floor — all the user's sessions across workspaces).
 *   - project lens: `"<id>"`/`string[]` narrows on the session's own projectId
 *     column (sessions carry projectId directly — a simple eq/inArray, NOT
 *     exposureLensWhere); `null`/`undefined`/`[]` → no narrow.
 * An empty array never narrows (never matches-zero); a lens can only restrict.
 */
/**
 * `list`: newest-started first, capped. Unchanged ordering for its consumers.
 *
 * `order: "open_first"` puts every OPEN session ahead of every settled one,
 * then newest-started within each — so a long-running open session can no
 * longer be pushed off the capped page by newer rows that have already
 * settled. That was the work map's vanishing-bar bug: `status: "all"`,
 * `limit: 50`, newest-started first, and a week-old blocked session was simply
 * not on the page. Pair it with an open-status set + `statusSince` to read
 * "everything open, plus what settled recently".
 */
export function queryUserSessions(
  query: SessionListQuery,
  limit: number,
  order: "started" | "open_first" = "started"
) {
  const base = db
    .select()
    .from(focusSessions)
    .where(and(...sessionListConditions(query)));
  return (
    order === "open_first"
      ? base.orderBy(
          desc(inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])),
          desc(focusSessions.startedAt),
          desc(focusSessions.id)
        )
      : base.orderBy(desc(focusSessions.startedAt))
  ).limit(limit);
}

/**
 * The derived fields EVERY session list row carries — lineage, triage, kind and
 * participants — applied in one place so `list` and `browse` return the same row
 * shape. Written once when `browse` arrived: a projection added to one door and
 * not the other is how a field ends up "present on the wire, populated by
 * nobody" on half the surfaces.
 */
export async function projectSessionRows(
  sessions: FocusSession[],
  userId: string | null | undefined
) {
  // Derived lineage for the whole page in ONE query (never N+1, never a
  // second store) — mirrors `synap_list_sessions` (mcp/handlers/session.ts).
  const withLineage = await attachParentSessionIds(sessions);
  // `triage` is projected onto EVERY row in EVERY lens (it is pure — no
  // query), so no consumer ever re-derives the predicate from origin +
  // metadata + status. That re-derivation is exactly how a second, drifting
  // copy of a rule gets written.
  const withTriage = attachTriage(withLineage);
  // `kind` rides along on EVERY row in EVERY lens, same contract as
  // `triage`: pure, no query, and the one place the predicate is decided.
  const withKind = attachSessionKind(withTriage);
  // WHO worked here — one shared derivation with `get` (see
  // `services/focus-sessions/participants.ts`), so a list row and a detail
  // page can never name different agents for the same session.
  //
  // UNCONDITIONAL, not behind a flag like `edges`. The cost is two indexed
  // reads for the whole page (`idx_proposals_session_id`, then one
  // `users` lookup that is SKIPPED when the page has no participants), and
  // the alternative is worse in kind rather than in degree: an opt-in flag
  // leaves the DEFAULT answer wrong, which is exactly why every consumer
  // reached past this door for the raw `agentIds` invite list instead. A
  // field present on the type and populated only under a flag nobody sets
  // is the "declared on the wire, populated by nobody" shape this codebase
  // keeps paying for. `triage`, `kind` and `parentSessionId` ride along the
  // same way and for the same reason.
  const withParticipants = await attachSessionParticipants(
    withKind,
    requireUserId(userId)
  );
  // The grade against the session's criteria — `verdict` present only on rows
  // that declare criteria. One batched read for the page (see
  // `attachSessionVerdicts`), same unconditional contract as participants.
  const { attachSessionVerdicts } = await import("./evaluations/record.js");
  return attachSessionVerdicts(withParticipants);
}

/**
 * `live` on every row — ONE batched liveness read for the page (the same
 * function behind `focusSessions.activity`'s `live`). A failed read is `null`
 * on each row, never a quiet session.
 */
export async function attachSessionLiveness<
  R extends FocusSession & { live?: SessionActivityLive | null },
>(
  rows: R[],
  reader: LivenessReader,
  opts: { since?: Date } = {}
): Promise<R[]> {
  const live = await loadSessionLiveness(reader, rows, opts);
  return rows.map((r) => ({ ...r, live: live.get(r.id) ?? null }));
}
/**
 * How many sessions `queryUserSessions` WOULD return with no limit — the SAME
 * conditions, so a capped door can say exactly how many rows it left out
 * instead of guessing from a full page.
 */
export async function countUserSessions(
  query: SessionListQuery
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(focusSessions)
    .where(and(...sessionListConditions(query)));
  return Number(row?.n ?? 0);
}
