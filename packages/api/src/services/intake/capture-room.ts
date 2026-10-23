/**
 * The capture ROOM, read once for the two readers that need more than its
 * parts: the AI turn a comment runs, and the re-read that takes the comments
 * into account.
 *
 * Founder rule (2026-10-12): a comment in a capture room stays a chat turn, but
 * the agent that replies must see the NOTE and the CURRENT SUGGESTIONS — and
 * "Update suggestions" re-reads with every comment since the last round. The
 * room's messages carry the comment history already; the note (a staged run
 * source) and the rows (a `capture_result` part, which the turn's history shows
 * only as "Structured N records") are what the agent could not see.
 *
 * Both ride EXISTING doors: the turn's `turnContext.entries` (the bounded bag
 * the IS already renders as untrusted reference data — no new IS contract, so
 * pod and IS deploy in either order), and the structure request's `comments`.
 */

import { shortenTitle } from "@synap-core/types/titles";
import {
  db,
  messages,
  MessageRole,
  focusSessions,
  documentVersions,
  and,
  eq,
  desc,
  isNull,
  isNotNull,
  inArray,
  gte,
  lte,
  notInArray,
  asc,
  links,
  drizzleSql,
} from "@synap/database";
import {
  deriveCaptureRoomState,
  type CaptureRoomMessage,
  type CaptureRoomState,
} from "@synap-core/types/capture";
import {
  resolveCaptureChipStateLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { TERMINAL_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import type { AnyColumn } from "drizzle-orm";
import { readSessionRunManifest } from "./record-session-run-manifest.js";
import { loadSourceRows } from "../focus-sessions/rerun-session.js";
import {
  TURN_CONTEXT_MAX_ARRAY_ITEMS,
  TURN_CONTEXT_MAX_ARRAY_STRING_LENGTH,
  TURN_CONTEXT_MAX_ENTRIES,
  TURN_CONTEXT_MAX_STRING_LENGTH,
  TurnContextSchema,
  type TurnContext,
} from "../../routers/channels/helpers.js";

/** Capture parts read per room. A room past this is not a capture thread. */
const ROOM_PARTS_MAX = 200;
/** Comments a re-read carries (the IS caps the same). Oldest dropped first. */
export const RESTRUCTURE_COMMENTS_MAX = 20;
export const RESTRUCTURE_COMMENT_MAX_CHARS = 1000;

/**
 * Read a capture room and fold it through the ONE derivation
 * (`deriveCaptureRoomState`). `ownerId` selects whose plain messages are the
 * note and the comments (a co-member's message is not the owner's correction).
 * Reads the room's capture parts, its first plain owner message (the note
 * candidate) and the owner's latest {@link RESTRUCTURE_COMMENTS_MAX} plain
 * messages.
 */
export async function readCaptureRoom(args: {
  channelId: string;
  ownerId: string;
  database?: typeof db;
}): Promise<CaptureRoomState> {
  const database = args.database ?? db;
  const columns = {
    id: messages.id,
    role: messages.role,
    userId: messages.userId,
    content: messages.content,
    metadata: messages.metadata,
    timestamp: messages.timestamp,
  };
  const ownerPlain = and(
    eq(messages.channelId, args.channelId),
    eq(messages.userId, args.ownerId),
    eq(messages.role, MessageRole.USER),
    eq(messages.ephemeral, false),
    isNull(messages.deletedAt),
    drizzleSql`NOT (COALESCE(${messages.metadata}, '{}'::jsonb) ? 'capturePart')`
  );
  const [parts, first, latest] = await Promise.all([
    database
      .select(columns)
      .from(messages)
      .where(
        and(
          eq(messages.channelId, args.channelId),
          isNull(messages.deletedAt),
          drizzleSql`${messages.metadata} ? 'capturePart'`
        )
      )
      .orderBy(desc(messages.timestamp), desc(messages.id))
      .limit(ROOM_PARTS_MAX),
    database
      .select(columns)
      .from(messages)
      .where(ownerPlain)
      .orderBy(asc(messages.timestamp), asc(messages.id))
      .limit(1),
    database
      .select(columns)
      .from(messages)
      .where(ownerPlain)
      .orderBy(desc(messages.timestamp), desc(messages.id))
      .limit(RESTRUCTURE_COMMENTS_MAX),
  ]);
  const byId = new Map(
    [...parts, ...first, ...latest].map((m) => [m.id, m] as const)
  );
  return deriveCaptureRoomState([...byId.values()], { ownerId: args.ownerId });
}

/**
 * The note a capture session structured: the newest TEXT source the run staged
 * (`metadata.run.sourceDocumentIds`), read from its version row. `null` when
 * the run kept no text source (a photo-only capture) — never a guess.
 */
export async function readCaptureNoteText(args: {
  sessionId: string;
  userId: string;
  database?: typeof db;
}): Promise<string | null> {
  const database = args.database ?? db;
  const [session] = await database
    .select({ metadata: focusSessions.metadata })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    )
    .limit(1);
  if (!session) return null;
  const ids = readSessionRunManifest(session.metadata)?.sourceDocumentIds ?? [];
  if (ids.length === 0) return null;
  const { present } = await loadSourceRows(database, args.userId, ids);
  const text = [...present].reverse().find((s) => s.meta.kind === "text");
  if (!text) return null;
  const [version] = await database
    .select({ content: documentVersions.content })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, text.sourceDocumentId))
    .orderBy(desc(documentVersions.version))
    .limit(1);
  const body = version?.content?.trim();
  return body ? body : null;
}

const cut = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * The turn-context entries that tell the agent what this capture is: the note,
 * the current suggestions with where each stands, the AI's own space/project
 * reasons and any open question. PURE, and bounded to the entry contract.
 */
export function buildCaptureTurnEntries(input: {
  note: string | null;
  room: CaptureRoomState;
}): TurnContext["entries"] & object {
  const entries: Array<{
    key: string;
    value: string | number | boolean | string[];
  }> = [{ key: "capture.kind", value: "capture_room" }];
  if (input.note) {
    entries.push({
      key: "capture.note",
      value: cut(input.note, TURN_CONTEXT_MAX_STRING_LENGTH),
    });
    if (input.note.length > TURN_CONTEXT_MAX_STRING_LENGTH) {
      entries.push({ key: "capture.noteTruncated", value: true });
    }
  }
  const result = input.room.result?.part;
  if (result) {
    entries.push({ key: "capture.round", value: result.round });
    const rows = input.room.rows;
    const lines = rows
      .slice(0, TURN_CONTEXT_MAX_ARRAY_ITEMS)
      .map((view) =>
        cut(
          `${resolveCaptureChipStateLabel(view.state)} · ${resolveObjectNoun(view.row.profileSlug)} · ${view.row.title}`,
          TURN_CONTEXT_MAX_ARRAY_STRING_LENGTH
        )
      );
    entries.push({ key: "capture.suggestions", value: lines });
    if (rows.length > TURN_CONTEXT_MAX_ARRAY_ITEMS || result.truncated) {
      entries.push({ key: "capture.suggestionsTruncated", value: true });
    }
    const space =
      result.placement?.workspaceName ??
      result.placement?.suggestion?.workspaceName ??
      null;
    if (space) {
      entries.push({
        key: "capture.space",
        value: cut(space, TURN_CONTEXT_MAX_STRING_LENGTH),
      });
    }
    if (result.project?.reason) {
      entries.push({
        key: "capture.projectReason",
        value: cut(result.project.reason, TURN_CONTEXT_MAX_STRING_LENGTH),
      });
    }
  }
  const question = input.room.question;
  if (question?.open) {
    entries.push({
      key: "capture.openQuestion",
      value: cut(question.part.question, TURN_CONTEXT_MAX_STRING_LENGTH),
    });
  }
  return entries;
}

/**
 * Fold the capture entries into a turn's context. The capture entries go
 * FIRST (server-owned, the reason this turn exists); the caller's own entries
 * follow and are the ones dropped when the shared caps would be exceeded, so
 * the result always passes `TurnContextSchema`.
 */
export function withCaptureTurnEntries(
  base: Record<string, unknown> | undefined,
  captureEntries: NonNullable<TurnContext["entries"]>
): Record<string, unknown> {
  const own = Array.isArray((base as TurnContext | undefined)?.entries)
    ? ((base as TurnContext).entries ?? [])
    : [];
  const ownKeys = new Set(captureEntries.map((e) => e.key));
  const caller = own.filter((e) => !ownKeys.has(e.key));
  for (let keep = caller.length; keep >= 0; keep--) {
    const entries = [...captureEntries, ...caller.slice(0, keep)].slice(
      0,
      TURN_CONTEXT_MAX_ENTRIES
    );
    const candidate = { ...(base ?? {}), entries };
    // The anchor rides outside the serialized ceiling (pod + IS agree).
    const { anchor: _anchor, ...checked } = candidate as {
      anchor?: unknown;
    } & Record<string, unknown>;
    if (TurnContextSchema.safeParse(checked).success) return candidate;
  }
  return { ...(base ?? {}), entries: captureEntries };
}

/**
 * THE "is a capture room" predicate, as SQL over a channel id column: the room
 * holds a capture part. Nothing else marks a capture — a note session relay
 * opens with `focusSessions.create` carries no intake stamp, so any marker on
 * the session would miss it. `deriveCaptureRoomState(...).isCaptureRoom` is
 * the same rule over messages already read.
 */
export function capturePartInRoom(channelId: AnyColumn) {
  return drizzleSql`exists (select 1 from ${messages} where ${messages.channelId} = ${channelId} and ${messages.deletedAt} is null and ${messages.metadata} ? 'capturePart')`;
}

/** Does this room hold a capture part? One indexed probe. */
export async function roomHoldsCapturePart(args: {
  channelId: string;
  database?: typeof db;
}): Promise<boolean> {
  const database = args.database ?? db;
  const [row] = await database
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, args.channelId),
        isNull(messages.deletedAt),
        drizzleSql`${messages.metadata} ? 'capturePart'`
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether a person's message in a room should run a capture turn, and the
 * entries it carries. Only the session OWNER's plain comment in a room that
 * holds capture parts qualifies; anything else answers `null` and the send
 * door's normal restraint applies. A failed read THROWS; the send door logs it
 * and the comment still stands, with no capture turn.
 */
export async function planCaptureCommentTurn(args: {
  channelId: string;
  userId: string;
  database?: typeof db;
}): Promise<{
  agentType: string;
  entries: NonNullable<TurnContext["entries"]>;
} | null> {
  const database = args.database ?? db;
  if (!(await roomHoldsCapturePart({ channelId: args.channelId, database }))) {
    return null;
  }
  const [session] = await database
    .select({ id: focusSessions.id, userId: focusSessions.userId })
    .from(focusSessions)
    .where(eq(focusSessions.channelId, args.channelId))
    .orderBy(desc(focusSessions.updatedAt))
    .limit(1);
  if (!session || session.userId !== args.userId) return null;
  const room = await readCaptureRoom({
    channelId: args.channelId,
    ownerId: args.userId,
    database,
  });
  if (!room.isCaptureRoom) return null;
  const note =
    (await readCaptureNoteText({
      sessionId: session.id,
      userId: args.userId,
      database,
    })) ??
    room.note?.text ??
    null;
  return {
    agentType: "meta",
    entries: buildCaptureTurnEntries({ note, room }),
  };
}

/** Settled records a re-read names, newest round first. */
export const RESTRUCTURE_SETTLED_MAX = 20;
/** A source note's title — the first line, as relay names the note it saves. */
const SOURCE_NOTE_TITLE_MAX = 80;

/** A record the room already settled: the re-read must not propose it again. */
export interface SettledCaptureRecord {
  profileSlug: string;
  title: string;
  outcome: "filed" | "awaiting_approval" | "rejected";
}

/**
 * What a re-read of a capture session takes from its room:
 *  - `comments`: the owner's comments since the last round (never the note);
 *  - `previousEntities`: only when there are comments, that round's still
 *    suggested rows, so the structurer keeps a record the comments do not
 *    touch (same tempId, title, kind);
 *  - `settled`: every record already filed, waiting for approval or rejected
 *    (earlier rounds included) — told to the structurer as "do not propose
 *    these again";
 *  - `noteTitle`: the first line of the room's note, when the room holds one —
 *    the note is already kept, so it must not come back as a suggestion.
 * `null` when the session is not the caller's or has no room.
 */
export async function readRestructureRoom(args: {
  sessionId: string;
  userId: string;
  database?: typeof db;
}): Promise<{
  comments: string[];
  previousEntities?: Array<{
    tempId: string;
    profileSlug: string;
    title: string;
    properties?: Record<string, unknown>;
  }>;
  settled?: SettledCaptureRecord[];
  noteTitle?: string;
} | null> {
  const database = args.database ?? db;
  const [session] = await database
    .select({ channelId: focusSessions.channelId })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    )
    .limit(1);
  if (!session?.channelId) return null;
  const room = await readCaptureRoom({
    channelId: session.channelId,
    ownerId: args.userId,
    database,
  });
  const noteLine = room.note?.text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l !== "");
  const noteTitle = noteLine
    ? shortenTitle(noteLine, SOURCE_NOTE_TITLE_MAX)
    : undefined;
  const settled = room.rows
    .flatMap((view): SettledCaptureRecord[] =>
      view.state === "filed" ||
      view.state === "awaiting_approval" ||
      view.state === "rejected"
        ? [
            {
              profileSlug: view.row.profileSlug,
              title: view.row.title,
              outcome: view.state,
            },
          ]
        : []
    )
    .slice(0, RESTRUCTURE_SETTLED_MAX);
  const context = {
    ...(settled.length > 0 ? { settled } : {}),
    ...(noteTitle ? { noteTitle } : {}),
  };
  if (!room.isCaptureRoom || room.commentsSinceResult.length === 0) {
    return { comments: [], ...context };
  }
  const open = room.rows
    .filter((view) => view.state === "suggested" && !view.carried)
    .map((view) => view.row);
  return {
    comments: room.commentsSinceResult
      .slice(-RESTRUCTURE_COMMENTS_MAX)
      .map((c) => c.text.slice(0, RESTRUCTURE_COMMENT_MAX_CHARS)),
    ...(open.length > 0
      ? {
          previousEntities: open.map((row) => ({
            tempId: row.tempId,
            profileSlug: row.profileSlug,
            title: row.title,
            ...(row.properties ? { properties: row.properties } : {}),
          })),
        }
      : {}),
    ...context,
  };
}

/** Capture parts read per room when many rooms are folded at once. */
export const CAPTURE_ROOM_PARTS_PER_CHANNEL = 40;

/**
 * The capture parts of many rooms, for `deriveCaptureRoomState`: each room's
 * newest {@link CAPTURE_ROOM_PARTS_PER_CHANNEL} result / filed / question /
 * answer parts, projected to the part alone (never the whole metadata). A
 * room past the bound loses its OLDEST parts first — an early round's carry,
 * never the latest result. A channel with no part is absent from the map.
 */
export async function readCaptureRoomParts(args: {
  channelIds: string[];
  database?: typeof db;
}): Promise<Map<string, CaptureRoomMessage[]>> {
  const database = args.database ?? db;
  const out = new Map<string, CaptureRoomMessage[]>();
  if (args.channelIds.length === 0) return out;
  const ranked = database
    .select({
      id: messages.id,
      channelId: messages.channelId,
      timestamp: messages.timestamp,
      part: drizzleSql<unknown>`${messages.metadata} -> 'capturePart'`.as(
        "part"
      ),
      rank: drizzleSql<number>`row_number() over (partition by ${messages.channelId} order by ${messages.timestamp} desc, ${messages.id} desc)`.as(
        "rank"
      ),
    })
    .from(messages)
    .where(
      and(
        inArray(messages.channelId, args.channelIds),
        isNull(messages.deletedAt),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'kind' in ('capture_result', 'capture_filed', 'capture_question', 'capture_answer')`
      )
    )
    .as("ranked");
  const rows = await database
    .select({
      id: ranked.id,
      channelId: ranked.channelId,
      timestamp: ranked.timestamp,
      part: ranked.part,
    })
    .from(ranked)
    .where(lte(ranked.rank, CAPTURE_ROOM_PARTS_PER_CHANNEL));
  for (const r of rows) {
    if (!r.channelId) continue;
    const list = out.get(r.channelId) ?? [];
    list.push({
      id: r.id,
      timestamp: r.timestamp,
      metadata: { capturePart: r.part },
    });
    out.set(r.channelId, list);
  }
  return out;
}

/** Capture sessions read per Needs-you pass (newest touched first). */
export const UNFINISHED_CAPTURES_SCAN = 50;
/** A capture untouched for longer than this no longer asks for attention. */
export const UNFINISHED_CAPTURE_WINDOW_MS = 14 * 24 * 3_600_000;

export interface UnfinishedCapture {
  sessionId: string;
  title: string | null;
  goal: string | null;
  updatedAt: Date;
  projectId: string | null;
  status: "needs_answer" | "suggested";
}

/**
 * The person's own capture sessions that still owe them something — an OPEN
 * question, or suggestions nobody filed or refused — touched in the last
 * {@link UNFINISHED_CAPTURE_WINDOW_MS}. Owner-floored (a capture room is the
 * owner's). `truncated` when the scan hit its cap. A failed read THROWS.
 * SESSION-KIND-LENS-EXEMPT: returns UnfinishedCapture needs-you rows, never a session row; the population is the owner's own capture rooms (owner floor + capturePartInRoom), not a kind/triage list.
 */
export async function listUnfinishedCaptures(args: {
  userId: string;
  now?: Date;
  database?: typeof db;
}): Promise<{ captures: UnfinishedCapture[]; truncated: boolean }> {
  const database = args.database ?? db;
  const since = new Date(
    (args.now ?? new Date()).getTime() - UNFINISHED_CAPTURE_WINDOW_MS
  );
  const sessions = await database
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      updatedAt: focusSessions.updatedAt,
      projectId: focusSessions.projectId,
      channelId: focusSessions.channelId,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, args.userId),
        isNotNull(focusSessions.channelId),
        notInArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES]),
        gte(focusSessions.updatedAt, since),
        capturePartInRoom(focusSessions.channelId)
      )
    )
    .orderBy(desc(focusSessions.updatedAt))
    .limit(UNFINISHED_CAPTURES_SCAN);
  const truncated = sessions.length >= UNFINISHED_CAPTURES_SCAN;
  if (sessions.length === 0) return { captures: [], truncated };

  const [rooms, produced] = await Promise.all([
    readCaptureRoomParts({
      channelIds: sessions.map((s) => s.channelId!),
      database,
    }),
    database
      .selectDistinct({ fromId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          inArray(
            links.fromId,
            sessions.map((s) => s.id)
          ),
          eq(links.toType, "entity"),
          eq(links.linkType, "produced")
        )
      ),
  ]);
  const producedSessions = new Set(produced.map((r) => r.fromId));

  const captures: UnfinishedCapture[] = [];
  for (const s of sessions) {
    const parts = rooms.get(s.channelId!);
    if (!parts) continue;
    const status = deriveCaptureRoomState(parts, {
      producedRecords: producedSessions.has(s.id),
    }).owed.status;
    if (!status) continue;
    captures.push({
      sessionId: s.id,
      title: s.title,
      goal: s.goal,
      updatedAt: s.updatedAt,
      projectId: s.projectId ?? null,
      status,
    });
  }
  return { captures, truncated };
}
