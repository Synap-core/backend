/**
 * insertChannelMessage — the single channel-message writer that ALSO mirrors.
 *
 * Insert a message row into a channel and, if that channel is bound to Discord,
 * mirror the content out via `mirrorMessageToBoundExternal`. New producers
 * (mail-feed worker, event-sync worker, and any future feed) use this instead of
 * a bare `db.insert(messages)` so Discord delivery is automatic and consistent.
 *
 * It does NOT emit the app realtime event (`emitChatEvent` lives in `@synap/api`);
 * api-side callers that need live UI updates broadcast separately. The mirror is
 * the value this helper adds over a raw insert.
 */

import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../client-pg.js";
import { computeMessageHash } from "./message-hash.js";
import {
  messages,
  MessageRole,
  MessageAuthorType,
  type MessageCategory,
  MessageDirection,
  type MessageDeliveryStatus,
} from "../schema/index.js";
import {
  mirrorMessageToBoundExternal,
  type MirrorChannelRef,
} from "./mirror-to-external.js";
import { emitMessageEvent } from "./emit-message-event.js";
import { withoutServerOwnedMessageMeta } from "@synap-core/types/agents";

export interface InsertChannelMessageParams {
  channelId: string;
  content: string;
  /** Message author identity — defaults to a system/bot user. */
  userId?: string;
  role?: MessageRole;
  authorType?: MessageAuthorType;
  /**
   * Free metadata. The server-owned keys (`roomPost`, `sessionPost`,
   * `routeChoice`) are DROPPED: callers pass metadata from outside (the
   * `feed.post` verb, an automation's message config), and those stamps are
   * written only by `postChannelMessage`.
   */
  metadata?: Record<string, unknown>;
  /** Message category (e.g. SYSTEM_NOTIFICATION for feed / system posts). */
  messageCategory?: MessageCategory;
  /** Pass the channel row to let the mirror skip a lookup. */
  channel?: MirrorChannelRef;
  /**
   * Explicit row id. Pass a DETERMINISTIC id (e.g. derived from run+node+iter)
   * to make a retried insert idempotent: the row's primary key IS the
   * idempotency key, so a redelivered producer conflicts on it and no-ops
   * (`onConflictDoNothing` below) instead of duplicating the message. Omit for
   * a fresh random id. The hash is always `computeMessageHash(id, content)`, so
   * the tamper chain stays consistent whichever id is used.
   */
  id?: string;
  /**
   * A channel with a person (0393): which way the message went. `outbound` is
   * a message the person sent out through a tool; `inbound` one that arrived.
   * Absent = an in-pod chat message (column NULL).
   */
  direction?: MessageDirection;
  /** How far an outbound message got (`sent` → `delivered` → `read`). */
  deliveryStatus?: MessageDeliveryStatus;
  /**
   * The provider's own id for this message. Unique per channel
   * (`messages_channel_ext_msg_uniq`): the provider's echo of a message the
   * pod sent and the pod's own row are ONE row.
   */
  externalMessageId?: string;
  /**
   * The message was ALREADY delivered to its outside tool by the caller (the
   * send door): never mirror it out again. Without this an outbound send on a
   * Discord-bound channel would be posted twice.
   */
  alreadyDelivered?: boolean;
  /**
   * When the row conflicts on (channel, external message id) — the provider's
   * echo landed first — merge `metadata` into THAT row instead of dropping it,
   * so the row the person sees carries what the send door knows (the proposal,
   * the account, who drafted it). Needs `externalMessageId`.
   */
  mergeMetadataOnConflict?: boolean;
  /** The outside tool the message went through or came from (`linkedin`…). */
  externalSource?: string;
  /** The person the channel is bound to: carried on the `message.sent` fact. */
  entityId?: string | null;
  /** The workspace the fact is logged in. */
  workspaceId?: string | null;
}

export interface InsertChannelMessageResult {
  messageId: string | undefined;
  mirrored: boolean;
  mirrorReason?: string;
  /**
   * True when this call created the row. False when it conflicted (a replayed
   * deterministic id, or the provider's echo of the same external message);
   * `messageId` then names the existing row when it could be found by its
   * external message id.
   */
  inserted: boolean;
}

/**
 * Insert a channel message + mirror to Discord if bound. Never throws on the
 * mirror path (a delivery failure must not fail the insert).
 */
export async function insertChannelMessage(
  params: InsertChannelMessageParams
): Promise<InsertChannelMessageResult> {
  const {
    channelId,
    content,
    userId = "system",
    role = MessageRole.ASSISTANT,
    authorType = MessageAuthorType.BOT,
    messageCategory,
    channel,
  } = params;
  const metadata = withoutServerOwnedMessageMeta(params.metadata);

  const database = await getDb();
  // Canonical tamper-hash: computeMessageHash(id, content, previousHash="") —
  // the ONE formula (see message-hash.ts). Generate the id up front so the
  // stored hash matches the row's id (the previous `channelId:ts:content`
  // formula was drift, not comparable to the tamper chain). A caller-supplied
  // deterministic id (idempotency key) wins over a fresh random one.
  const id = params.id ?? randomUUID();
  const hash = computeMessageHash(id, content);

  const [msg] = await database
    .insert(messages)
    .values({
      id,
      channelId,
      userId,
      role,
      authorType,
      content,
      hash,
      previousHash: "",
      ...(messageCategory ? { messageCategory } : {}),
      ...(metadata
        ? { metadata: metadata as (typeof messages.$inferInsert)["metadata"] }
        : {}),
      ...(params.direction ? { direction: params.direction } : {}),
      ...(params.deliveryStatus
        ? { deliveryStatus: params.deliveryStatus }
        : {}),
      ...(params.externalMessageId
        ? { externalMessageId: params.externalMessageId }
        : {}),
      ...(params.externalSource
        ? { externalSource: params.externalSource }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });

  // The provider's echo of this external message landed first: one row per
  // provider message per channel. Merge what this writer knows into that row
  // (metadata only: the echo's content and author stay), and say so.
  if (!msg && params.externalMessageId) {
    const [existing] = params.mergeMetadataOnConflict
      ? await database
          .update(messages)
          .set({
            metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify(
              metadata ?? {}
            )}::jsonb`,
          })
          .where(
            and(
              eq(messages.channelId, channelId),
              eq(messages.externalMessageId, params.externalMessageId)
            )
          )
          .returning({ id: messages.id })
      : await database
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.channelId, channelId),
              eq(messages.externalMessageId, params.externalMessageId)
            )
          )
          .limit(1);
    return {
      messageId: existing?.id,
      mirrored: false,
      mirrorReason: "duplicate-insert-skipped",
      inserted: false,
    };
  }

  // Mirror ONLY when this call actually inserted the row. `msg === undefined`
  // means the PK conflicted — a redelivered producer re-sent a deterministic
  // id whose row (and mirror enqueue) already happened on the prior delivery;
  // mirroring again would double-post to the bound external (Discord). The
  // egress enqueue itself has no idempotency key, so this gate is the dedup.
  const mirror = !msg
    ? { mirrored: false, reason: "duplicate-insert-skipped" as const }
    : params.alreadyDelivered
      ? { mirrored: false, reason: "already-delivered" as const }
      : await mirrorMessageToBoundExternal({
          channel,
          channelId,
          content,
          authorType,
        });

  // Keystone fact write: append `message.sent` to the `events` log — ONLY
  // when this call actually landed a NEW row (same guard as the mirror
  // above; `msg === undefined` is the onConflict no-op, already observed on
  // the prior delivery). No entityId: this writer doesn't load the channel's
  // contextObjectType, and adding that lookup here would be a new query for
  // every producer post — an honest absence beats a per-write lookup.
  if (msg) {
    await emitMessageEvent({
      // An inbound row (a provider message recorded here) is a received fact.
      type:
        params.direction === MessageDirection.INBOUND
          ? "message.received"
          : "message.sent",
      userId,
      channelId,
      messageId: msg.id,
      workspaceId: params.workspaceId ?? null,
      entityId: params.entityId ?? null,
      data: {
        authorType,
        role,
        ...(params.direction ? { direction: params.direction } : {}),
      },
    });
  }

  return {
    messageId: msg?.id,
    mirrored: mirror.mirrored,
    mirrorReason: mirror.reason,
    inserted: !!msg,
  };
}
