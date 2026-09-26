/**
 * Focus-session READ visibility — the ONE predicate every session read scopes
 * by (founder decision C, 2026-09-25).
 *
 * A session is readable by:
 *
 *   1. its OWNER (`focus_sessions.user_id = me`), OR
 *   2. a HUMAN on the roster of the session's OWN room — a `channel_members` row
 *      with `member_kind = 'human'` on the channel that is BOTH the session's
 *      `channel_id` AND stamped by the session-room mint (`ensureSessionChannel`)
 *      `context_object_type = 'focus_session'`, `context_object_id = <this
 *      session>`, and whose `users` row is a human.
 *
 * Both branches are narrowed by the caller's workspace lens exactly as the old
 * `workspaceOwned` rule narrowed the owner branch — a lens only ever narrows.
 *
 * READ ONLY. Membership grants SEEING the session (page, outputs, criteria,
 * plan, usage, document, evaluations). Every WRITE stays owner-only: the write
 * doors keep their `eq(focusSessions.userId, …)` floor on purpose. Proposal
 * review rights are untouched (`canReviewProposal`, workspace roles).
 *
 * Why BOTH the FK and the stamp — each alone is forgeable:
 *   - the FK alone: a session can BORROW an existing channel (a client team
 *     channel, the chat it started in). Keying on it would hand the session to
 *     everyone on that borrowed channel's roster.
 *   - the stamp alone: the stamp is NOT written only by the mint. The
 *     `channel.ensure` capability takes `contextObjectType` as a free string
 *     and creates a thread OWNED BY THE CALLER stamped with any type + id, and
 *     `room-people` then lets that caller (the channel's owner) seat humans on
 *     it — so a workspace member who learns a session id could mint a
 *     "focus_session/<victim>" room, seat themselves, and read the session.
 *   The mint writes the stamp AND points the session's `channel_id` at the room
 *   in one transaction; only the session's owner can move `channel_id`. The
 *   pair therefore names exactly THIS session's own room.
 *
 * Why `member_kind = 'human'` AND `users.user_type = 'human'`: an agent on the
 * roster gains nothing from this rule (an agent reads through its principal's
 * grants, never through a seat). Both columns are checked so a mis-enrolled
 * agent row (`enrollRoomMember` takes the kind from its caller) still cannot
 * open a session.
 *
 * Deliberately NOT a branch: `project_members`, workspace membership, channel
 * roster of a BORROWED channel. Filing a session into a project does not share
 * it (option B was rejected: it would retroactively expose every filed session).
 *
 */
import {
  and,
  eq,
  inArray,
  isNotNull,
  notInArray,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { db } from "@synap/database";
import {
  artifacts,
  channelMembers,
  channels,
  ChannelMemberKind,
  focusSessions,
  sessionEvaluations,
  users,
} from "@synap/database/schema";
import { SESSION_DOCUMENT_LABEL } from "../services/session-document/label.js";
import { workspaceLensWhere } from "../utils/user-visible-where.js";
import { SESSION_ROOM_CONTEXT_TYPE } from "../utils/channel-visibility.js";

type WorkspaceLens = string | string[] | null | undefined;

/** Subqueries only — never executed on their own. */
const qb = new QueryBuilder();

/**
 * The ids of every session whose MINTED room seats `userId` as a human — an
 * UNCORRELATED subquery on purpose: the relational query builder
 * (`db.query.focusSessions.findFirst`) aliases the outer table
 * (`"focusSessions"`), and a correlated reference to `focus_sessions.id` inside
 * a subquery is not rewritten to that alias ("invalid reference to FROM-clause
 * entry"). `outer.id IN (…)` keeps the only outer reference at top level.
 */
function rosterSessionIds(userId: string) {
  const seats = rosterSeats(eq(channelMembers.memberId, userId)).as("seats");
  return qb.select({ id: seats.sessionId }).from(seats);
}

/**
 * The ONE join that says "a human seat on a session's own minted room" —
 * `(sessionId, memberId)` pairs narrowed by `narrow`. Both the read predicate
 * and the audience helper below go through it.
 */
function rosterSeats(narrow: SQL) {
  return (
    qb
      .select({
        sessionId: focusSessions.id,
        memberId: channelMembers.memberId,
      })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      // The room must be the session's OWN channel (FK) AND carry the mint's
      // stamp naming that session — see the module doc for why each alone leaks.
      .innerJoin(
        focusSessions,
        and(
          eq(focusSessions.channelId, channels.id),
          eq(focusSessions.id, channels.contextObjectId)
        )
      )
      .innerJoin(users, eq(users.id, channelMembers.memberId))
      .where(
        and(
          eq(channels.contextObjectType, SESSION_ROOM_CONTEXT_TYPE),
          narrow,
          eq(channelMembers.memberKind, ChannelMemberKind.HUMAN),
          eq(users.userType, "human")
        )
      )
  );
}

/**
 * `userId` is a HUMAN seat on the roster of the room minted for the session
 * whose id is `sessionIdColumn` (defaults to `focus_sessions.id`).
 */
export function sessionRosterMemberWhere(
  userId: string,
  sessionIdColumn: AnyColumn = focusSessions.id
): SQL {
  return inArray(sessionIdColumn, rosterSessionIds(userId));
}

/**
 * Everyone who may READ `sessionId` on a human door: its owner plus each human
 * seat for which {@link sessionReadableWhere} holds (so the workspace floor
 * applies too). For fan-out (e.g. a realtime push audience) — never a grant on
 * its own. One derivation: candidates come from the same seat join, and each
 * is confirmed through the read predicate itself. Throws on a failed read.
 */
export async function sessionReaderIds(sessionId: string): Promise<string[]> {
  const [session] = await db
    .select({ userId: focusSessions.userId })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  if (!session) return [];
  const r = rosterSeats(eq(focusSessions.id, sessionId)).as("r");
  const seats = await db.select({ memberId: r.memberId }).from(r);
  const out = new Set<string>([session.userId]);
  for (const { memberId } of seats) {
    if (out.has(memberId)) continue;
    const [ok] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, sessionId),
          sessionReadableWhere({ userId: memberId, roster: true })
        )
      )
      .limit(1);
    if (ok) out.add(memberId);
  }
  return [...out];
}

/**
 * Who is asking, and through which kind of door.
 *
 * `roster` says whether this read honours the roster branch. v1 grants it to
 * HUMAN doors only: a request carrying an agent key (`agentUserId` set — Hub
 * REST, MCP, a delegated tRPC call) reads owner-only, exactly as before
 * decision C ("agents on the roster gain nothing new"; widening the agent doors
 * is a separate, explicit call). It DEFAULTS TO FALSE, so a service reached by
 * a caller that says nothing keeps the pre-decision owner-only answer — the
 * widening is opt-in per door, never inherited by accident.
 */
export interface SessionReader {
  userId: string;
  /** Workspace lens — narrows both branches. */
  lens?: WorkspaceLens;
  /** Honour the human-roster branch. Default false (owner-only). */
  roster?: boolean;
}

/**
 * THE session read predicate: owner OR (human door) human roster member. Use it
 * in every session READ; never in a write.
 *
 * - The OWNER branch is the bare owner floor the read doors always used — with
 *   `roster: false` this predicate is byte-for-byte the old `eq(userId)`.
 * - The MEMBER branch is additionally floored on the session's workspace
 *   (`workspaceLensWhere`): a seat outlives nothing — a person removed from the
 *   workspace stops reading its sessions even if the roster row lingers.
 * - A `lens`, when given, narrows BOTH branches (a lens only ever narrows).
 */
export function sessionReadableWhere(reader: SessionReader): SQL {
  const { userId, lens, roster = false } = reader;
  const owner = eq(focusSessions.userId, userId);
  const base = roster
    ? or(
        owner,
        and(
          sessionRosterMemberWhere(userId),
          workspaceLensWhere(focusSessions.workspaceId, userId, lens)
        )
      )!
    : owner;
  return lens === undefined
    ? base
    : and(base, workspaceLensWhere(focusSessions.workspaceId, userId, lens))!;
}

/**
 * Does a request context honour the roster branch? A HUMAN door does; an agent
 * key (`agentUserId` set) does not (v1) — nor does any Hub Protocol caller
 * (`isHubProtocol`, set only by the agent-key auth middleware), which
 * `AccessContext.from` already routes to the AGENT factory. Without the second
 * check a Hub REST door that re-enters a tRPC router without an
 * `agentUserId` (e.g. `GET /proposals/:id`) read as a human door.
 */
export function rosterReadFor(ctx: {
  agentUserId?: string | null;
  isHubProtocol?: boolean;
}): boolean {
  return !ctx.agentUserId && !ctx.isHubProtocol;
}

/**
 * A session's DOCUMENT (the one `getOrCreateSessionDocument` designates: its
 * title is the session's name, its body the closing report) is as readable as
 * the session. Returns a NARROWING conjunct for a `documents` read: true for
 * every document that is not the designated document of a session `reader`
 * may not read. Composes with the document's own rule by AND — it never
 * widens. Uncorrelated for the same alias reason as `rosterSessionIds`.
 *
 * Both `IS NOT NULL` filters are load-bearing: `x NOT IN (…, NULL)` is NULL,
 * which would silently hide EVERY document.
 */
export function sessionDocumentReadableWhere(
  documentIdColumn: AnyColumn,
  reader: SessionReader
): SQL {
  // `artifacts.ref_id` is TEXT (it names any renderable kind); the uuid id is
  // cast to compare, the same direction the artifact rows were written.
  return notInArray(
    sql`${documentIdColumn}::text`,
    qb
      .select({ id: artifacts.refId })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.kind, "document"),
          sql`${artifacts.props}->>'expectedLabel' = ${SESSION_DOCUMENT_LABEL}`,
          isNotNull(artifacts.refId),
          isNotNull(artifacts.sessionId),
          notInArray(
            artifacts.sessionId,
            qb
              .select({ id: focusSessions.id })
              .from(focusSessions)
              .where(sessionReadableWhere(reader))
          )
        )
      )
  );
}

/**
 * `session_evaluations` rows are exactly as readable as the session they grade.
 */
export function sessionEvaluationReadableWhere(reader: SessionReader): SQL {
  // Uncorrelated for the same alias reason as `rosterSessionIds`.
  return inArray(
    sessionEvaluations.sessionId,
    qb
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(sessionReadableWhere(reader))
  );
}

/**
 * Who the viewer is TO this session — the field read doors expose so a UI can
 * hide write verbs for a member. Only meaningful on a row the viewer already
 * read through {@link sessionReadableWhere}.
 */
export type SessionViewerRole = "owner" | "member";

export function sessionViewerRole(
  row: { userId: string },
  viewerId: string
): SessionViewerRole {
  return row.userId === viewerId ? "owner" : "member";
}
