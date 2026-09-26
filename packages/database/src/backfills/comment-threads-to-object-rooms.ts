/**
 * BACKFILL — per-comment THREAD channels → the object's ONE room (Documents v2).
 *
 * Until 2026-09-26 a document / entity comment was a NEW owner-private THREAD
 * channel (`metadata.origin = 'comment'`) holding one message, linked to the
 * object by a `message_links` row `{relationshipType:'comments', position}`.
 * Now a comment is a message in the object's room carrying `metadata.anchor`,
 * and replies carry `parent_id = <root>` (services/comments/comments.ts).
 *
 * Per legacy thread (active, stamped document|entity):
 *   1. the object's room — `ChannelRepository.ensureObjectChannel` (the one
 *      mint). A missing object → the thread is REPORTED (`orphaned`) and left
 *      untouched: there is no room to move it into;
 *   2. its FIRST message becomes the thread ROOT: moved into the room,
 *      `message_category = 'comment'`, and anchored:
 *        - document → `{kind:'document', documentId, offset?}` from the link's
 *          `position` — `{0,0}` was the old "Whole document" and gets NO
 *          offset (whole document); a heading at offset 0 was stored as
 *          `{0, len}` and keeps its offset (the bug the old `start > 0` test
 *          had). No quote: the body the offset pointed into is not read here;
 *        - entity   → `{kind:'entity', entityId}`;
 *   3. every later message becomes a REPLY (`parent_id = root`) in the room;
 *      `session_id` is cleared on all of them (it named the OLD channel's
 *      memory session);
 *   4. the old thread is ARCHIVED with `metadata.mergedInto = <room>`;
 *   5. the `comments` message links of the moved messages are deleted (the
 *      anchor replaces them).
 * One transaction per thread. Idempotent: a moved thread is archived, so a
 * second run finds nothing. DRY RUN (the default at the CLI) plans only.
 *
 * NOT run against any pod by the author (lane brief). Run:
 *   pnpm --filter @synap/database backfill:comment-threads           # dry run
 *   pnpm --filter @synap/database backfill:comment-threads --apply   # writes
 */

import { and, asc, eq, inArray, isNull, sql as drizzleSql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import { channels, ChannelStatus, ChannelType } from "../schema/channels.js";
import { messages, MessageCategory } from "../schema/messages.js";
import { messageLinks } from "../schema/message-links.js";
import { ChannelRepository } from "../repositories/channel-repository.js";
import {
  isObjectRoomType,
  type ObjectRoomType,
} from "../utils/channel-visibility.js";

type Database = PostgresJsDatabase<typeof schema>;

export interface CommentThreadPlan {
  legacyChannelId: string;
  object: { type: ObjectRoomType; id: string };
  roomChannelId: string | null;
  rootMessageId: string | null;
  replyCount: number;
  anchor: Record<string, unknown> | null;
  outcome: "moved" | "planned" | "orphaned" | "empty";
}

export interface CommentThreadBackfillSummary {
  dryRun: boolean;
  threads: number;
  moved: number;
  orphaned: number;
  empty: number;
  messagesMoved: number;
  plans: CommentThreadPlan[];
}

/** The anchor a legacy root gets (see the docblock, step 2). */
export function legacyAnchor(
  object: { type: ObjectRoomType; id: string },
  position: unknown
): Record<string, unknown> {
  if (object.type === "entity") return { kind: "entity", entityId: object.id };
  const pos = position as { start?: unknown; end?: unknown } | null;
  const start = typeof pos?.start === "number" ? pos.start : null;
  const end = typeof pos?.end === "number" ? pos.end : null;
  const hasSection =
    start !== null && end !== null && start >= 0 && end > start;
  return {
    kind: "document",
    documentId: object.id,
    ...(hasSection ? { offset: { start, end } } : {}),
  };
}

export async function backfillCommentThreads(
  database: Database,
  options: { dryRun: boolean; limit?: number }
): Promise<CommentThreadBackfillSummary> {
  const legacy = await database
    .select({
      id: channels.id,
      contextObjectType: channels.contextObjectType,
      contextObjectId: channels.contextObjectId,
      metadata: channels.metadata,
    })
    .from(channels)
    .where(
      and(
        eq(channels.channelType, ChannelType.THREAD),
        eq(channels.status, ChannelStatus.ACTIVE),
        drizzleSql`${channels.metadata} ->> 'origin' = 'comment'`,
        inArray(channels.contextObjectType, ["document", "entity"])
      )
    )
    .orderBy(asc(channels.createdAt))
    .limit(options.limit ?? 10_000);

  const summary: CommentThreadBackfillSummary = {
    dryRun: options.dryRun,
    threads: legacy.length,
    moved: 0,
    orphaned: 0,
    empty: 0,
    messagesMoved: 0,
    plans: [],
  };

  for (const thread of legacy) {
    if (
      !isObjectRoomType(thread.contextObjectType) ||
      !thread.contextObjectId
    ) {
      continue;
    }
    const object = {
      type: thread.contextObjectType,
      id: thread.contextObjectId,
    };
    const rows = await database
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, thread.id), isNull(messages.deletedAt)))
      .orderBy(asc(messages.timestamp), asc(messages.id));
    const plan: CommentThreadPlan = {
      legacyChannelId: thread.id,
      object,
      roomChannelId: null,
      rootMessageId: rows[0]?.id ?? null,
      replyCount: Math.max(rows.length - 1, 0),
      anchor: null,
      outcome: "planned",
    };
    summary.plans.push(plan);
    if (rows.length === 0) {
      plan.outcome = "empty";
      summary.empty++;
      continue;
    }

    const [link] = await database
      .select({ position: messageLinks.position })
      .from(messageLinks)
      .where(
        and(
          eq(messageLinks.messageId, rows[0].id),
          eq(messageLinks.relationshipType, "comments")
        )
      )
      .limit(1);
    plan.anchor = legacyAnchor(object, link?.position ?? null);

    if (options.dryRun) {
      // Plan only — does the object still exist to give a room?
      const probe = await findRoomOrObject(database, object);
      if (probe === false) {
        plan.outcome = "orphaned";
        summary.orphaned++;
      } else if (typeof probe === "string") {
        plan.roomChannelId = probe;
      }
      continue;
    }

    const moved = await database.transaction(async (tx) => {
      const room = await new ChannelRepository(
        tx as unknown as Database
      ).ensureObjectChannel(object);
      if (!room) return null;
      const ids = rows.map((r) => r.id);
      const [rootId, ...replyIds] = ids;
      await tx
        .update(messages)
        .set({
          channelId: room.channel.id,
          parentId: null,
          sessionId: null,
          messageCategory: MessageCategory.COMMENT,
          metadata: drizzleSql`COALESCE(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ anchor: plan.anchor })}::jsonb`,
        })
        .where(eq(messages.id, rootId));
      if (replyIds.length > 0) {
        await tx
          .update(messages)
          .set({
            channelId: room.channel.id,
            parentId: rootId,
            sessionId: null,
            messageCategory: MessageCategory.COMMENT,
          })
          .where(inArray(messages.id, replyIds));
      }
      await tx
        .delete(messageLinks)
        .where(
          and(
            inArray(messageLinks.messageId, ids),
            eq(messageLinks.relationshipType, "comments")
          )
        );
      await tx
        .update(channels)
        .set({
          status: ChannelStatus.ARCHIVED,
          updatedAt: new Date(),
          metadata: drizzleSql`COALESCE(${channels.metadata}, '{}'::jsonb) || ${JSON.stringify({ mergedInto: room.channel.id })}::jsonb`,
        })
        .where(eq(channels.id, thread.id));
      return room.channel.id;
    });

    if (!moved) {
      plan.outcome = "orphaned";
      summary.orphaned++;
      continue;
    }
    plan.roomChannelId = moved;
    plan.outcome = "moved";
    summary.moved++;
    summary.messagesMoved += rows.length;
  }
  return summary;
}

/**
 * Dry-run probe: the existing room id, `true` when the object exists but has no
 * room yet (the apply would mint one), `false` when the object is gone.
 */
async function findRoomOrObject(
  database: Database,
  object: { type: ObjectRoomType; id: string }
): Promise<string | true | false> {
  const [room] = await database
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.channelType, ChannelType.GROUP),
        eq(channels.status, ChannelStatus.ACTIVE),
        eq(channels.contextObjectType, object.type),
        eq(channels.contextObjectId, object.id)
      )
    )
    .limit(1);
  if (room) return room.id;
  const table = object.type === "document" ? "documents" : "entities";
  const found = await database.execute(
    drizzleSql`SELECT 1 FROM ${drizzleSql.identifier(table)} WHERE id = ${object.id} AND deleted_at IS NULL LIMIT 1`
  );
  const rowsOf = (r: unknown) =>
    Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
  return rowsOf(found).length > 0;
}
