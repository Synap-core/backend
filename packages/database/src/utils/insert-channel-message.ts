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
import { getDb } from "../client-pg.js";
import { computeMessageHash } from "./message-hash.js";
import {
  messages,
  MessageRole,
  MessageAuthorType,
  type MessageCategory,
} from "../schema/index.js";
import {
  mirrorMessageToBoundExternal,
  type MirrorChannelRef,
} from "./mirror-to-external.js";

export interface InsertChannelMessageParams {
  channelId: string;
  content: string;
  /** Message author identity — defaults to a system/bot user. */
  userId?: string;
  role?: MessageRole;
  authorType?: MessageAuthorType;
  metadata?: Record<string, unknown>;
  /** Message category (e.g. SYSTEM_NOTIFICATION for feed / system posts). */
  messageCategory?: MessageCategory;
  /** Pass the channel row to let the mirror skip a lookup. */
  channel?: MirrorChannelRef;
}

export interface InsertChannelMessageResult {
  messageId: string | undefined;
  mirrored: boolean;
  mirrorReason?: string;
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
    metadata,
    messageCategory,
    channel,
  } = params;

  const database = await getDb();
  // Canonical tamper-hash: computeMessageHash(id, content, previousHash="") —
  // the ONE formula (see message-hash.ts). Generate the id up front so the
  // stored hash matches the row's id (the previous `channelId:ts:content`
  // formula was drift, not comparable to the tamper chain).
  const id = randomUUID();
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
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });

  const mirror = await mirrorMessageToBoundExternal({
    channel,
    channelId,
    content,
    authorType,
  });

  return {
    messageId: msg?.id,
    mirrored: mirror.mirrored,
    mirrorReason: mirror.reason,
  };
}
