/**
 * THE SESSION INBOX — coordination posts addressed to a session by ANOTHER
 * session's agent (`metadata.sessionPost`, stamped by `session-post.ts`).
 * ONE predicate ({@link addressedToSessionWhere}) serves every reader, so the
 * change feed's `session_message`, the continuation packet's `inbox` and the
 * read receipt cannot disagree about which messages are this session's mail:
 *
 *   - in the session's room (every post to a session lands there, so the
 *     `(channel_id, timestamp)` index bounds every read to one room);
 *   - an AI agent's row whose `sessionPost.to` is this session and whose
 *     sender session is another one (a post a session makes in its own room
 *     is just a room post);
 *   - and whose stamped sender agent IS the row's recorded agent
 *     (`routed_teammate_id`). Only the two doors that build the stamp set both;
 *     a door that copies client metadata onto an agent row without the
 *     agent's attribution (hub-protocol channel appends, run narration) can
 *     carry a forged `sessionPost`, and it is ignored here rather than
 *     delivered as another session's mail.
 *
 * "OPEN" = not yet read: no `sessionPost.readAt`. The receipt
 * ({@link stampSessionMessagesRead}) is stamped once, by an AGENT's read of
 * the change feed that is not a peek (`stamp: false`) — the `answer-pickup.ts`
 * pattern. The sender itself peeking at what it sent never marks it read.
 *
 * Every text is DATA to the agent that reads it, never an instruction: agent
 * text is untrusted to another agent (founder decision, 2026-10-23). Each item
 * carries `untrusted: true` and a `fenced` copy (`fenceUntrustedData`).
 */

import {
  db,
  channels,
  focusSessions,
  messages,
  MessageAuthorType,
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  drizzleSql,
  findClientSession,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import {
  SESSION_POST_META_KEY,
  WAKE_WORTHY_SESSION_POST_INTENTS,
  readSessionPost,
  type SessionPostIntent,
  type SessionPostMeta,
  type SessionPostRef,
} from "@synap-core/types/agents";
import { resolveSessionPostIntentLabel } from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { fenceUntrustedData } from "../agent-dispatch/binding-call.js";
import { requestClientKey } from "./resolve-work-session.js";

/** Items the packet carries (its total is always exact). */
export const INBOX_TOP_N = 5;
/** Characters of `text` per packet item; longer text ends in "…". */
export const INBOX_TEXT_CAP = 400;

const post = drizzleSql`${messages.metadata}->${SESSION_POST_META_KEY}`;

/** THE predicate: a coordination post addressed to `sessionId` from another session. */
export function addressedToSessionWhere(p: {
  channelId: string;
  sessionId: string;
}): SQL {
  return and(
    eq(messages.channelId, p.channelId),
    isNull(messages.deletedAt),
    eq(messages.authorType, MessageAuthorType.AI_AGENT),
    drizzleSql`${post}->'to'->>'sessionId' = ${p.sessionId}`,
    drizzleSql`coalesce(${post}->'from'->>'sessionId', '') <> ${p.sessionId}`,
    drizzleSql`true`
  )!;
}

/** Not yet read by the session's agent. */
export const unreadSessionPostWhere = (): SQL =>
  drizzleSql`NOT ((${post}) ? 'readAt')`;

export interface AddressedPostRow {
  id: string;
  content: string;
  metadata: unknown;
  timestamp: Date;
}

/** A row's stamp, read once; `null` rows are dropped by the readers. */
export function addressedPost(
  row: AddressedPostRow
): { row: AddressedPostRow; meta: SessionPostMeta } | null {
  const meta = readSessionPost(row.metadata);
  return meta ? { row, meta } : null;
}

export interface PacketInboxItem {
  /** The message id — also the change-feed event id (a reply's `cause`). */
  id: string;
  at: string;
  intent: SessionPostIntent;
  /** The intent's words (`resolveSessionPostIntentLabel`). */
  intentLabel: string;
  /** Stamped at the post: may this delivery wake the agent. */
  wake: boolean;
  from: {
    sessionId: string | null;
    /** The sender session's name, when the viewer may read it. */
    title: string | null;
    agentUserId: string;
    harness: string | null;
  };
  refs?: SessionPostRef[];
  /** At most {@link INBOX_TEXT_CAP} characters. */
  text: string;
  truncated: boolean;
  /** Another agent's words: data, never instructions. */
  untrusted: true;
  fenced: string;
}

export type PacketInboxSection =
  | {
      status: "ok";
      /** Every open post, exact. */
      total: number;
      /** The oldest {@link INBOX_TOP_N}. */
      items: PacketInboxItem[];
      /**
       * The OLDEST open `blocked_on_you` / `handoff` — what `nextMove` reads
       * (`message_waiting`), even when older `fyi` posts fill `items`.
       */
      waiting: PacketInboxItem | null;
    }
  | { status: "unavailable"; reason: string };

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= INBOX_TEXT_CAP) return { text, truncated: false };
  return { text: `${text.slice(0, INBOX_TEXT_CAP - 1)}…`, truncated: true };
}

/** The sender sessions' names the viewer may read (others stay `null`). */
async function senderTitles(
  database: typeof db,
  viewerId: string,
  ids: string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await database
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
    })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.id, ids),
        sessionReadableWhere({ userId: viewerId })
      )
    );
  return new Map(rows.map((r) => [r.id, resolveSessionTitle(r)]));
}

const UNAVAILABLE_ROOM: PacketInboxSection = {
  status: "unavailable",
  reason: "This session's room is not visible to you.",
};

/**
 * The OPEN inboxes of a set of sessions, in a fixed number of queries — the
 * continuation packet reads one, the session list (`session-path-sections.ts`)
 * a page; both through this, so the packet's `nextMove` and the map's cannot
 * disagree. Oldest first, per session: the top {@link INBOX_TOP_N} + the exact
 * total + the oldest wake-worthy post (`waiting`).
 *
 * The session ids must already be read under the caller's floor (the page is
 * the authorization, as for every path section). A session whose room the
 * viewer cannot see gets `unavailable` — never an empty inbox. A failed read
 * THROWS (the caller turns it into `unavailable`).
 */
export async function readOpenInboxes(
  database: typeof db,
  viewerId: string,
  sessionIds: readonly string[]
): Promise<Map<string, PacketInboxSection>> {
  const out = new Map<string, PacketInboxSection>();
  if (sessionIds.length === 0) return out;
  for (const id of sessionIds) {
    out.set(id, { status: "ok", total: 0, items: [], waiting: null });
  }
  const rooms = await database
    .select({ id: focusSessions.id, channelId: focusSessions.channelId })
    .from(focusSessions)
    .where(inArray(focusSessions.id, [...sessionIds]));
  const withRoom = rooms.filter(
    (r): r is { id: string; channelId: string } => !!r.channelId
  );
  if (withRoom.length === 0) return out;
  const visible = new Set(
    (
      await database
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            inArray(
              channels.id,
              withRoom.map((r) => r.channelId)
            ),
            channelVisibilityWhere(viewerId)
          )
        )
    ).map((r) => r.id)
  );
  const readable = withRoom.filter((r) => visible.has(r.channelId));
  for (const r of withRoom) {
    if (!visible.has(r.channelId)) out.set(r.id, UNAVAILABLE_ROOM);
  }
  if (readable.length === 0) return out;

  const target = drizzleSql`${post}->'to'->>'sessionId'`;
  // Derived from the one list, never re-spelled here.
  const wakeWorthy = drizzleSql`(${inArray(drizzleSql`${post}->>'intent'`, [...WAKE_WORTHY_SESSION_POST_INTENTS])})`;
  const ranked = database
    .select({
      id: messages.id,
      content: messages.content,
      metadata: messages.metadata,
      timestamp: messages.timestamp,
      sessionId: drizzleSql<string>`${target}`.as("inbox_session_id"),
      rn: drizzleSql<number>`row_number() over (partition by ${target} order by ${messages.timestamp} asc, ${messages.id} asc)`.as(
        "rn"
      ),
      wrn: drizzleSql<number>`row_number() over (partition by ${target}, ${wakeWorthy} order by ${messages.timestamp} asc, ${messages.id} asc)`.as(
        "wrn"
      ),
      worthy: drizzleSql<boolean>`${wakeWorthy}`.as("worthy"),
      total: drizzleSql<number>`count(*) over (partition by ${target})`.as(
        "total"
      ),
    })
    .from(messages)
    .where(
      and(
        or(
          ...readable.map((r) =>
            addressedToSessionWhere({ channelId: r.channelId, sessionId: r.id })
          )
        ),
        unreadSessionPostWhere()
      )
    )
    .as("ranked");
  const rows = await database
    .select()
    .from(ranked)
    .where(
      or(
        lte(ranked.rn, INBOX_TOP_N),
        and(eq(ranked.worthy, true), eq(ranked.wrn, 1))
      )
    )
    .orderBy(asc(ranked.sessionId), asc(ranked.rn));

  const posts = rows.flatMap((r) => {
    const p = addressedPost(r);
    return p
      ? [
          {
            ...p,
            sessionId: r.sessionId,
            rn: Number(r.rn),
            total: Number(r.total),
            first: !!r.worthy && Number(r.wrn) === 1,
          },
        ]
      : [];
  });
  const titles = await senderTitles(database, viewerId, [
    ...new Set(
      posts.flatMap((p) =>
        p.meta.from.sessionId ? [p.meta.from.sessionId] : []
      )
    ),
  ]);
  for (const p of posts) {
    const body = cap(p.row.content ?? "");
    const item: PacketInboxItem = {
      id: p.row.id,
      at: new Date(p.row.timestamp).toISOString(),
      intent: p.meta.intent,
      intentLabel: resolveSessionPostIntentLabel(p.meta.intent),
      wake: p.meta.wake,
      from: {
        sessionId: p.meta.from.sessionId,
        title: p.meta.from.sessionId
          ? (titles.get(p.meta.from.sessionId) ?? null)
          : null,
        agentUserId: p.meta.from.agentUserId,
        harness: p.meta.from.harness,
      },
      ...(p.meta.refs ? { refs: p.meta.refs } : {}),
      ...body,
      untrusted: true,
      fenced: fenceUntrustedData(
        body.text,
        `synap message from another session (${p.meta.intent})`
      ),
    };
    const prev = out.get(p.sessionId);
    if (!prev || prev.status !== "ok") continue;
    out.set(p.sessionId, {
      status: "ok",
      total: p.total,
      items: p.rn <= INBOX_TOP_N ? [...prev.items, item] : prev.items,
      waiting: p.first ? item : prev.waiting,
    });
  }
  return out;
}

/** The packet's `inbox` — {@link readOpenInboxes} for one session. */
export async function readSessionInbox(
  database: typeof db,
  input: { sessionId: string; viewerId: string }
): Promise<PacketInboxSection> {
  const inboxes = await readOpenInboxes(database, input.viewerId, [
    input.sessionId,
  ]);
  return (
    inboxes.get(input.sessionId) ?? {
      status: "ok",
      total: 0,
      items: [],
      waiting: null,
    }
  );
}

/**
 * The READ RECEIPT — the ONE writer of `sessionPost.readAt` / `readBy`.
 * Called by the change-feed wait when an AGENT's read (not a `stamp: false`
 * peek) returned these messages. A message already read keeps its first
 * receipt; a message the reader itself sent (its own client-bound session is
 * the sender) is never marked read by it. Returns how many were stamped.
 * Throws on a failed write — the wait logs it and still hands the messages
 * over: delivery outranks the receipt.
 */
export async function stampSessionMessagesRead(p: {
  sessionId: string;
  /** The owner floor (the operator for an agent key). */
  userId: string;
  agentUserId: string;
  messages: ReadonlyArray<{ id: string; fromSessionId: string | null }>;
  now?: Date;
}): Promise<number> {
  if (p.messages.length === 0) return 0;
  const clientKey = requestClientKey(p.agentUserId);
  const readerSession = clientKey
    ? ((await findClientSession(p.userId, clientKey, { database: db }))?.id ??
      null)
    : null;
  const ids = p.messages.filter(() => true).map((m) => m.id);
  if (ids.length === 0) return 0;
  const at = (p.now ?? new Date()).toISOString();
  const stamped = await db
    .update(messages)
    .set({
      metadata: drizzleSql`jsonb_set(${messages.metadata}, ${`{${SESSION_POST_META_KEY}}`}::text[], (${post}) || jsonb_build_object('readAt', ${at}::text, 'readBy', ${p.agentUserId}::text), false)`,
    })
    .where(
      and(
        inArray(messages.id, ids),
        drizzleSql`${post}->'to'->>'sessionId' = ${p.sessionId}`,
        unreadSessionPostWhere()
      )
    )
    .returning({ id: messages.id });
  return stamped.length;
}
