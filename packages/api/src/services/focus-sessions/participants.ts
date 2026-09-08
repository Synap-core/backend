/**
 * Session PARTICIPANTS — the roster of everyone staffed on a focus session,
 * projected onto a session row.
 *
 * Lives here, beside `parent-lineage.ts` / `triage.ts` / `session-kind.ts`, for
 * exactly the reason those exist: the derivation was written INLINE inside
 * `focusSessions.get` and `focusSessions.list` had no equivalent, so a session
 * LIST could not say which agents worked in it. Consumers then read the raw
 * `focus_sessions.agentIds` column instead (relay's `SessionActiveCard`), which
 * is the INVITE LIST whose own schema comment says not to read it as truth —
 * and which is empty on nearly every live session. One implementation, two
 * doors, nothing to keep in lockstep.
 *
 * TWO STORES, UNIONED — each knows half the answer:
 *
 *   1. DERIVED — agents that actually WORKED here, read off the proposals they
 *      filed against the session. This is evidence, and it is why the roster
 *      was derived in the first place.
 *   2. DECLARED — `focus_sessions.agentIds`. Historically an invite list only
 *      create-time writers could set; `attachSessionAgent` is now the append
 *      door, so a declared-but-not-yet-productive agent is a real answer this
 *      surface must show.
 *
 * An agent that filed no proposal is still on the session, and an agent nobody
 * declared still did the work — so it is a UNION, never one or the other.
 */

import { db, and, inArray, isNotNull, proposals, users } from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { displayNameForUser } from "../../routers/proposals/display.js";

/** One party on a session. `name` is resolved — never a bare uuid. */
export interface SessionParticipant {
  id: string;
  name: string;
}

/** The projection this module attaches. */
export interface SessionParticipants {
  participants: SessionParticipant[];
}

/**
 * Minimum a row must carry to be staffed: its id, and the DECLARED half of the
 * union. Deliberately `unknown` rather than `string[] | null` — the column is a
 * Drizzle `text[]` whose rows predate the append door, and narrowing happens
 * once, here, instead of at every call site with a cast.
 */
type StaffableSession = { id: string; agentIds: unknown };

function declaredAgentIds(session: StaffableSession): string[] {
  const raw = session.agentIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v !== "");
}

/**
 * BATCH form — ONE proposals query and ONE users query for the WHOLE page,
 * never N+1 and never a second store, the same shape `attachParentSessionIds`
 * / `attachSessionEdges` / `attachSessionOutputDependencies` already use.
 * `idx_proposals_session_id` (migration 0119) backs the `IN` scan, and the
 * page is SQL-limit-capped at 50, so this is two indexed reads regardless of
 * page size.
 *
 * `userId` is the SAME access predicate every other proposal read uses —
 * owning the session does not by itself entitle you to a proposal filed into a
 * workspace you have since left.
 */
export async function attachSessionParticipants<T extends StaffableSession>(
  sessions: readonly T[],
  userId: string
): Promise<Array<T & SessionParticipants>> {
  if (sessions.length === 0) return [];

  const derivedRows = await db
    .selectDistinct({
      sessionId: proposals.sessionId,
      agentUserId: proposals.agentUserId,
    })
    .from(proposals)
    .where(
      and(
        inArray(
          proposals.sessionId,
          sessions.map((s) => s.id)
        ),
        isNotNull(proposals.agentUserId),
        userVisibleWhere(proposals.workspaceId, userId)
      )
    );

  // Union the two stores per session. A Set collapses an agent present in both.
  const idsBySession = new Map<string, Set<string>>();
  for (const session of sessions) {
    idsBySession.set(session.id, new Set(declaredAgentIds(session)));
  }
  for (const row of derivedRows) {
    if (!row.sessionId || !row.agentUserId) continue;
    idsBySession.get(row.sessionId)?.add(row.agentUserId);
  }

  // SORTED. Postgres guarantees no ordering for SELECT DISTINCT, and the UI
  // assigns each party a colour by INDEX — so an unsorted set lets two agents
  // swap tones between two refetches of the same session, on a surface FOUR
  // consumers poll at 30s. Deterministic order is the difference between a
  // stable roster and a flickering one. Invisible to `tsc` and to any test that
  // does not assert order, so `participants.test.ts` asserts order.
  const sortedBySession = new Map<string, string[]>(
    [...idsBySession].map(([id, set]) => [id, [...set].sort()])
  );

  // Resolve to display names in the SAME batch shape `proposals.list` uses for
  // its agent labels — one `inArray`, one `displayNameForUser`. A bare uuid is
  // not a name, and a party cluster rendering `4f2a…` would be a WORSE answer
  // than the empty list this replaces.
  const allIds = [...new Set([...sortedBySession.values()].flat())];
  const nameById = new Map<string, string>();
  if (allIds.length > 0) {
    const agentRows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        userType: users.userType,
        agentMetadata: users.agentMetadata,
      })
      .from(users)
      .where(inArray(users.id, allIds));
    for (const u of agentRows) {
      // `displayNameForUser` returns `undefined` for a row with no name, no
      // agentType/description and no email — left unset so the uuid-prefix
      // fallback below is the single place that decision is made.
      const name = displayNameForUser(u);
      if (name) nameById.set(u.id, name);
    }
  }

  return sessions.map((session) => ({
    ...session,
    participants: (sortedBySession.get(session.id) ?? []).map((id) => ({
      id,
      // LAST RESORT only: a `users` row that vanished, or one `displayNameForUser`
      // could not name at all. A bare full uuid is a worse answer than the empty
      // list this projection replaces, which is why a name is resolved at all.
      name: nameById.get(id) ?? id.slice(0, 8),
    })),
  }));
}

/**
 * Single-session form, for `focusSessions.get`. Delegates to the batch so there
 * is exactly ONE derivation — a hand-mirrored single-row copy is how the two
 * doors forked in the first place.
 */
export async function withSessionParticipants<T extends StaffableSession>(
  session: T,
  userId: string
): Promise<T & SessionParticipants> {
  const [staffed] = await attachSessionParticipants([session], userId);
  // `attachSessionParticipants` returns one row per input row, so a one-element
  // input always yields a one-element output; the fallback exists only to keep
  // the return type honest without a non-null assertion.
  return staffed ?? { ...session, participants: [] };
}
