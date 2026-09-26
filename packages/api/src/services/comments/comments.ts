/**
 * Comments — the ONE door for a comment on an object (Documents v2, founder
 * model 2026-09-25/26).
 *
 * A comment is a MESSAGE in the object's ONE linked channel (its object room,
 * `object-channel.ts`), never a second store:
 *   - a thread ROOT carries `metadata.anchor` (the D19 contract extended:
 *     `ObjectCommentAnchorSchema` in `utils/message-anchor.ts`);
 *   - a REPLY carries `parent_id = <root>`;
 *   - RESOLVE is state on the root (`messages.resolved_at` / `resolved_by`).
 * So a comment always shows in the channel, and the rail is a filtered view of
 * that channel (`listObjectComments`).
 *
 * Floors (founder decision V2): WRITING a comment needs READ access to the
 * object (the Google model: a viewer may comment). RESOLVING needs the root's
 * author or a person who may EDIT the object — and it is a human act: no agent
 * door reaches `setCommentResolved` (agents propose, humans resolve).
 *
 * Agent comments are SPEECH, not mutations: like `synap_post_message` they are
 * ungoverned and attributed (`agentUserId` → `routed_teammate_id`). An agent's
 * suggested EDIT stays a document proposal (the patch door).
 *
 * The message itself is written by `postChannelMessage`, the one message door,
 * so mentions (`notifyRoomPost`, widened to the room's readers), the event log
 * and idempotency are the door's, not re-implemented here.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  asc,
  eq,
  inArray,
  isNull,
  isNotNull,
  drizzleSql,
  MessageAuthorType,
  MessageRole,
  users,
} from "@synap/database";
import { channels, messages, ChannelType } from "@synap/database/schema";
import { EventNames } from "@synap-core/types/events";
import { postChannelMessage } from "../messaging/post-message.js";
import { NotificationService } from "../../notifications/NotificationService.js";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";
import {
  canUserSeeChannel,
  isObjectRoomType,
} from "../../utils/channel-visibility.js";
import {
  canEditDocument,
  loadReadableDocument,
} from "../../utils/document-edit-access.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { extractHumanMentionHandles } from "../../utils/agent-handles.js";
import { handleCandidatesFor } from "../../routers/channels/helpers.js";
import {
  anchorObjectRef,
  ObjectCommentAnchorSchema,
  type ObjectCommentAnchor,
} from "../../utils/message-anchor.js";
import {
  assertObjectReadable,
  ensureObjectChannelFor,
  findObjectChannel,
  type ObjectRef,
} from "./object-channel.js";
import { SERVER_CONVERSATION_EVENTS } from "../../realtime/socket-events.js";

/** Longest comment body (same bound as the retired comment doors). */
export const COMMENT_CONTENT_MAX = 50_000;
/** Most threads one listing returns (a document with more is an outlier). */
const THREADS_MAX = 300;
const PREVIEW_MAX = 140;

type MessageRow = typeof messages.$inferSelect;

export interface PostCommentParams {
  /** The authenticated principal (an agent key: its human OWNER). */
  userId: string;
  /** The acting agent, when an agent key wrote it. */
  agentUserId?: string;
  /** A thread ROOT: what it is about. Exactly one of `anchor` / `parentId`. */
  anchor?: ObjectCommentAnchor;
  /** A REPLY: any message of the thread (its root is resolved here). */
  parentId?: string;
  content: string;
  idempotencyKey?: string;
}

export interface PostCommentResult {
  messageId: string;
  rootId: string;
  channelId: string;
  object: ObjectRef;
  ackState: "applied" | "duplicate-ignored";
}

/** The thread root a reply answers, with its room's object. */
async function loadThread(
  userId: string,
  messageId: string
): Promise<{ root: MessageRow; object: ObjectRef; channelId: string }> {
  const notFound = () =>
    new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
  const parent = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), isNull(messages.deletedAt)),
  });
  if (!parent) throw notFound();
  const root = parent.parentId
    ? await db.query.messages.findFirst({
        where: and(
          eq(messages.id, parent.parentId),
          isNull(messages.deletedAt)
        ),
      })
    : parent;
  if (!root || root.parentId || !readAnchor(root)) throw notFound();

  const room = await db.query.channels.findFirst({
    where: eq(channels.id, root.channelId),
    columns: {
      id: true,
      channelType: true,
      contextObjectType: true,
      contextObjectId: true,
    },
  });
  if (
    !room ||
    room.channelType !== ChannelType.GROUP ||
    !isObjectRoomType(room.contextObjectType) ||
    !room.contextObjectId
  ) {
    throw notFound();
  }
  const object: ObjectRef = {
    type: room.contextObjectType,
    id: room.contextObjectId,
  };
  // The object's own floor — a thread on an object the caller cannot read
  // does not exist for them.
  await assertObjectReadable(userId, object);
  return { root, object, channelId: room.id };
}

/** The anchor a stored root carries, or null (strict: the same schema). */
export function readAnchor(
  row: Pick<MessageRow, "metadata">
): ObjectCommentAnchor | null {
  const raw = (row.metadata as { anchor?: unknown } | null)?.anchor;
  const parsed = ObjectCommentAnchorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Post a comment (a root with an anchor) or a reply (with a parent). */
export async function postComment(
  params: PostCommentParams
): Promise<PostCommentResult> {
  const content = params.content.trim();
  if (!content) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Empty comment" });
  }
  if (Boolean(params.anchor) === Boolean(params.parentId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A comment names either an anchor (new thread) or a parent (reply)",
    });
  }

  let object: ObjectRef;
  let channelId: string;
  let root: MessageRow | null = null;
  if (params.anchor) {
    // Validate here too: the MCP door hands a JSON object straight in.
    const anchor = ObjectCommentAnchorSchema.parse(params.anchor);
    object = anchorObjectRef(anchor);
    // Write floor = READ access to the object (V2); mints the room if absent.
    channelId = (await ensureObjectChannelFor(params.userId, object)).id;
    params = { ...params, anchor };
  } else {
    const thread = await loadThread(params.userId, params.parentId!);
    root = thread.root;
    object = thread.object;
    // The room must still be THE object's room (an archived room takes no
    // replies — its object was deleted).
    const current = await ensureObjectChannelFor(params.userId, object);
    if (current.id !== thread.channelId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
    }
    channelId = thread.channelId;
  }

  const posted = await postChannelMessage({
    channelId,
    content,
    role: params.agentUserId ? "assistant" : "user",
    userId: params.userId,
    ...(params.agentUserId ? { agentUserId: params.agentUserId } : {}),
    idempotencyKey: params.idempotencyKey,
    comment: root
      ? { parentId: root.id }
      : { anchor: params.anchor as Record<string, unknown> },
  });
  const rootId = root?.id ?? posted.messageId;

  if (posted.ackState === "applied") {
    if (root) await notifyThreadAuthor({ root, params, content, channelId });
    broadcastComment({
      channelId,
      object,
      rootId,
      messageId: posted.messageId,
      userId: params.userId,
      content,
      role: params.agentUserId ? MessageRole.ASSISTANT : MessageRole.USER,
    });
  }

  return {
    messageId: posted.messageId,
    rootId,
    channelId,
    object,
    ackState: posted.ackState === "applied" ? "applied" : "duplicate-ignored",
  };
}

/**
 * A reply tells the thread's author (a person; an agent-authored root has no
 * one to tell) — unless they wrote the reply or were already @mentioned in it
 * (`notifyRoomPost` told them by name).
 */
async function notifyThreadAuthor(p: {
  root: MessageRow;
  params: PostCommentParams;
  content: string;
  channelId: string;
}): Promise<void> {
  const { root, params } = p;
  if (root.authorType !== MessageAuthorType.HUMAN) return;
  if (!params.agentUserId && root.userId === params.userId) return;
  try {
    const [author] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, root.userId))
      .limit(1);
    const handles = extractHumanMentionHandles(p.content);
    const candidates = handleCandidatesFor(author?.name ?? null);
    if (handles.some((h) => candidates.has(h))) return;

    const senderId = params.agentUserId ?? params.userId;
    const [sender] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, senderId))
      .limit(1);
    const room = await db.query.channels.findFirst({
      where: eq(channels.id, p.channelId),
      columns: { workspaceId: true },
    });
    await NotificationService.create({
      type: "comment.reply",
      userId: root.userId,
      workspaceId: room?.workspaceId ?? null,
      sourceType: "system",
      sourceId: p.channelId,
      data: {
        sender: sender?.name?.trim() || "Someone",
        preview:
          p.content.length > PREVIEW_MAX
            ? `${p.content.slice(0, PREVIEW_MAX)}…`
            : p.content,
        channelId: p.channelId,
        messageId: root.id,
      },
    });
  } catch {
    // Side effect only — a failed notification never fails the reply.
  }
}

/**
 * Tell every reader of the room: `comments:changed` (open rails refetch) and,
 * for a new message, `chat:message` (an open channel view appends it). The
 * audience is the room's read rule (`emitChatEvent` → the channel audience).
 */
function broadcastComment(p: {
  channelId: string;
  object: ObjectRef;
  rootId: string;
  messageId?: string;
  userId: string;
  content?: string;
  role?: MessageRole;
}): void {
  emitChatEvent({
    event: SERVER_CONVERSATION_EVENTS.COMMENTS_CHANGED,
    data: {
      channelId: p.channelId,
      objectType: p.object.type,
      objectId: p.object.id,
      rootId: p.rootId,
    },
    channelId: p.channelId,
    userId: p.userId,
  });
  if (p.messageId && p.content !== undefined) {
    emitChatEvent({
      event: EventNames.CHAT_MESSAGE,
      data: {
        threadId: p.channelId,
        message: {
          id: p.messageId,
          threadId: p.channelId,
          role: p.role,
          content: p.content,
          userId: p.userId,
          timestamp: new Date(),
        },
        userId: p.userId,
      },
      channelId: p.channelId,
      userId: p.userId,
    });
  }
}

/** May `userId` change the object (the editor floor)? */
async function isObjectEditor(
  userId: string,
  object: ObjectRef
): Promise<boolean> {
  if (object.type === "document") {
    const doc = await loadReadableDocument(userId, object.id);
    return (await canEditDocument(userId, doc)).allowed;
  }
  const { workspaceId, ownerId } = await assertObjectReadable(userId, object);
  try {
    await assertWorkspaceWrite(db, userId, { workspaceId, ownerId });
    return true;
  } catch (err) {
    if (err instanceof TRPCError && err.code === "FORBIDDEN") return false;
    throw err;
  }
}

/** The thread's own (human) author. */
function isAuthor(
  userId: string,
  root: Pick<MessageRow, "authorType" | "userId">
) {
  return root.authorType === MessageAuthorType.HUMAN && root.userId === userId;
}

/**
 * May `userId` resolve this thread? Its author, or an editor of the object —
 * the ONE rule: `setCommentResolved` enforces it and the listing reports it
 * (`canResolve`), so the rail never offers a resolve the door would refuse.
 */
async function mayResolve(
  userId: string,
  root: MessageRow,
  object: ObjectRef
): Promise<boolean> {
  return isAuthor(userId, root) || (await isObjectEditor(userId, object));
}

/**
 * Resolve / re-open a thread (a HUMAN door). Idempotent: setting the state it
 * already has changes nothing and broadcasts nothing.
 */
export async function setCommentResolved(params: {
  userId: string;
  messageId: string;
  resolved: boolean;
}): Promise<{ rootId: string; resolvedAt: Date | null; changed: boolean }> {
  const { root, object, channelId } = await loadThread(
    params.userId,
    params.messageId
  );
  if (!(await mayResolve(params.userId, root, object))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the comment's author or an editor can resolve it.",
    });
  }
  const isResolved = root.resolvedAt !== null;
  if (isResolved === params.resolved) {
    return { rootId: root.id, resolvedAt: root.resolvedAt, changed: false };
  }
  const [row] = await db
    .update(messages)
    .set(
      params.resolved
        ? { resolvedAt: drizzleSql`now()`, resolvedBy: params.userId }
        : { resolvedAt: null, resolvedBy: null }
    )
    .where(eq(messages.id, root.id))
    .returning({ resolvedAt: messages.resolvedAt });
  broadcastComment({
    channelId,
    object,
    rootId: root.id,
    userId: params.userId,
  });
  return {
    rootId: root.id,
    resolvedAt: row?.resolvedAt ?? null,
    changed: true,
  };
}

export type CommentState = "open" | "resolved";

export interface CommentReply {
  id: string;
  content: string;
  userId: string;
  authorType: string;
  agentUserId: string | null;
  timestamp: Date;
}

export interface CommentThread extends CommentReply {
  anchor: ObjectCommentAnchor;
  /** May the VIEWER resolve / re-open it (the same rule the door enforces)? */
  canResolve: boolean;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  replyCount: number;
  replies: CommentReply[];
}

export interface ObjectCommentsListing {
  /** The object room, or null when nobody has spoken about the object yet. */
  channelId: string | null;
  counts: { open: number; resolved: number };
  threads: CommentThread[];
}

function toReply(m: MessageRow): CommentReply {
  return {
    id: m.id,
    content: m.content,
    userId: m.userId,
    authorType: m.authorType,
    agentUserId: m.routedTeammateId ?? null,
    timestamp: m.timestamp,
  };
}

/**
 * THE listing door: an object's comment threads in one state, with both
 * counts. Floored by the object's read floor AND the room's channel
 * visibility. Never mints a room (a read does not write).
 */
export async function listObjectComments(params: {
  userId: string;
  object: ObjectRef;
  state: CommentState;
}): Promise<ObjectCommentsListing> {
  await assertObjectReadable(params.userId, params.object);
  const room = await findObjectChannel(params.object);
  if (!room)
    return { channelId: null, counts: { open: 0, resolved: 0 }, threads: [] };
  if (!(await canUserSeeChannel(db, room.id, params.userId))) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Object not found" });
  }

  const isRoot = and(
    eq(messages.channelId, room.id),
    isNull(messages.parentId),
    isNull(messages.deletedAt),
    eq(messages.ephemeral, false),
    drizzleSql`(${messages.metadata} -> 'anchor') IS NOT NULL`
  );
  const [counts] = await db
    .select({
      open: drizzleSql<number>`count(*) filter (where ${messages.resolvedAt} is null)::int`,
      resolved: drizzleSql<number>`count(*) filter (where ${messages.resolvedAt} is not null)::int`,
    })
    .from(messages)
    .where(isRoot);

  const roots = await db
    .select()
    .from(messages)
    .where(
      and(
        isRoot,
        params.state === "open"
          ? isNull(messages.resolvedAt)
          : isNotNull(messages.resolvedAt)
      )
    )
    .orderBy(asc(messages.timestamp))
    .limit(THREADS_MAX);

  const threads: CommentThread[] = [];
  const editor =
    roots.length > 0 && (await isObjectEditor(params.userId, params.object));
  const rootIds = roots.map((r) => r.id);
  const replies = rootIds.length
    ? await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, room.id),
            inArray(messages.parentId, rootIds),
            isNull(messages.deletedAt),
            eq(messages.ephemeral, false)
          )
        )
        .orderBy(asc(messages.timestamp))
    : [];
  for (const root of roots) {
    const anchor = readAnchor(root);
    if (!anchor) continue; // a malformed anchor is not a comment thread
    const mine = replies.filter((r) => r.parentId === root.id).map(toReply);
    threads.push({
      ...toReply(root),
      anchor,
      canResolve: editor || isAuthor(params.userId, root),
      resolvedAt: root.resolvedAt,
      resolvedBy: root.resolvedBy,
      replyCount: mine.length,
      replies: mine,
    });
  }

  return {
    channelId: room.id,
    counts: { open: counts?.open ?? 0, resolved: counts?.resolved ?? 0 },
    threads,
  };
}
