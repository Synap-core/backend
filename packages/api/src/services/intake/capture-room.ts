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
  drizzleSql,
} from "@synap/database";
import {
  readCapturePart,
  type CaptureFiledPart,
  type CaptureResultPart,
} from "@synap-core/types/capture";
import {
  resolveCaptureChipStateLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
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

export interface CaptureRoomRead {
  /** The latest `capture_result` (highest round, then latest), or null. */
  result: CaptureResultPart | null;
  /** Every `capture_filed` receipt, oldest first. */
  filed: CaptureFiledPart[];
  /** The latest still-open question's text, or null. */
  openQuestion: string | null;
  /** True when the room holds any capture part — i.e. it IS a capture room. */
  isCaptureRoom: boolean;
  /** The owner's own comments after the latest result, oldest first. */
  commentsSinceResult: string[];
}

/**
 * Read a capture room. `ownerId` selects whose plain messages count as
 * comments (a co-member's message is not the owner's correction).
 */
export async function readCaptureRoom(args: {
  channelId: string;
  ownerId: string;
  database?: typeof db;
}): Promise<CaptureRoomRead> {
  const database = args.database ?? db;
  const partRows = await database
    .select({
      id: messages.id,
      metadata: messages.metadata,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, args.channelId),
        isNull(messages.deletedAt),
        drizzleSql`${messages.metadata} ? 'capturePart'`
      )
    )
    .orderBy(desc(messages.timestamp), desc(messages.id))
    .limit(ROOM_PARTS_MAX);

  let result: CaptureResultPart | null = null;
  let resultAt: Date | null = null;
  let openQuestion: string | null = null;
  let questionAt: Date | null = null;
  const filed: CaptureFiledPart[] = [];
  for (const row of partRows) {
    const part = readCapturePart(row.metadata);
    if (!part) continue;
    if (part.kind === "capture_result") {
      // Highest round wins; rows are newest-first, so a tie keeps the later.
      if (!result || part.round > result.round) {
        result = part;
        resultAt = row.timestamp;
      }
    } else if (part.kind === "capture_filed") {
      filed.unshift(part);
    } else if (part.kind === "capture_question") {
      if (!questionAt) {
        questionAt = row.timestamp;
        openQuestion = part.status === "open" ? part.question : null;
      }
    }
  }

  const commentRows = await database
    .select({ content: messages.content, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, args.channelId),
        eq(messages.userId, args.ownerId),
        eq(messages.role, MessageRole.USER),
        eq(messages.ephemeral, false),
        isNull(messages.deletedAt),
        drizzleSql`NOT (COALESCE(${messages.metadata}, '{}'::jsonb) ? 'capturePart')`,
        ...(resultAt
          ? [drizzleSql`${messages.timestamp} > ${resultAt.toISOString()}`]
          : [])
      )
    )
    .orderBy(desc(messages.timestamp), desc(messages.id))
    .limit(RESTRUCTURE_COMMENTS_MAX);
  const commentsSinceResult = commentRows
    .map((r) => (r.content ?? "").trim())
    .filter((c) => c.length > 0)
    .map((c) => c.slice(0, RESTRUCTURE_COMMENT_MAX_CHARS))
    .reverse();

  return {
    result,
    filed,
    openQuestion,
    isCaptureRoom: partRows.some((r) => readCapturePart(r.metadata) !== null),
    commentsSinceResult,
  };
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

/** The chip state a row is in, in the client's chip-state tokens. PURE. */
export function captureRowState(
  row: CaptureResultPart["rows"][number],
  filed: ReadonlyArray<CaptureFiledPart>
): "proposed" | "filed" | "pending" | "refused" | "failed" {
  let outcome: string | null = null;
  for (const part of filed) {
    for (const f of part.rows) if (f.tempId === row.tempId) outcome = f.outcome;
  }
  if (outcome === "proposed") return "pending";
  if (outcome === "failed") return "failed";
  if (outcome) return "filed";
  return row.dismissed ? "refused" : "proposed";
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
  room: CaptureRoomRead;
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
  const result = input.room.result;
  if (result) {
    entries.push({ key: "capture.round", value: result.round });
    const lines = result.rows
      .slice(0, TURN_CONTEXT_MAX_ARRAY_ITEMS)
      .map((row) =>
        cut(
          `${resolveCaptureChipStateLabel(captureRowState(row, input.room.filed))} · ${resolveObjectNoun(row.profileSlug)} · ${row.title}`,
          TURN_CONTEXT_MAX_ARRAY_STRING_LENGTH
        )
      );
    entries.push({ key: "capture.suggestions", value: lines });
    if (result.rows.length > TURN_CONTEXT_MAX_ARRAY_ITEMS || result.truncated) {
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
  if (input.room.openQuestion) {
    entries.push({
      key: "capture.openQuestion",
      value: cut(input.room.openQuestion, TURN_CONTEXT_MAX_STRING_LENGTH),
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
 * Whether a person's message in a room should run a capture turn, and the
 * entries it carries. Only the session OWNER's plain comment in a room that
 * holds capture parts qualifies; anything else answers `null` and the send
 * door's normal restraint applies. Never throws: a failed read is logged by
 * the caller and the comment still stands.
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
  const note = await readCaptureNoteText({
    sessionId: session.id,
    userId: args.userId,
    database,
  });
  return {
    agentType: "meta",
    entries: buildCaptureTurnEntries({ note, room }),
  };
}

/**
 * What a re-read of a capture session takes from its room: the owner's
 * comments since the last round, and — only when there are comments — that
 * round's still-open rows, so the structurer keeps a record the comments do not
 * touch (same tempId, title, kind). Filed, waiting and rejected rows are left
 * out: they are settled and must not be proposed again. `null` when the session
 * is not the caller's or has no room.
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
  if (!room.isCaptureRoom || room.commentsSinceResult.length === 0) {
    return { comments: [] };
  }
  const open = (room.result?.rows ?? []).filter(
    (row) => captureRowState(row, room.filed) === "proposed"
  );
  return {
    comments: room.commentsSinceResult,
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
  };
}
