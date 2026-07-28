import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  ChatTurnStatus,
  chatTurnEvents,
  chatTurns,
  db,
  messages,
} from "@synap/database";

export type DurableChatTurn = typeof chatTurns.$inferSelect;
export type DurableChatTurnEvent = typeof chatTurnEvents.$inferSelect;

/**
 * Deterministic UUID from an arbitrary seed (e.g. Discord
 * `${channelId}:${messageId}`). `chat_turns.request_id` is a UUID column; non-
 * UUID client seeds (snowflakes) still need a stable idempotency key.
 */
export function stableUuidFromSeed(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  // RFC 4122 version-5 style nibble + variant so Postgres uuid accepts it.
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(h.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Reserve an idempotent chat turn WITHOUT inserting a user message.
 * Use when the user message is already durable (e.g. Discord inbound recorder)
 * and only the lifecycle ledger row is needed.
 */
export async function createOrGetChatTurn(input: {
  channelId: string;
  userId: string;
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
}): Promise<{ turn: DurableChatTurn; created: boolean }> {
  const [created] = await db
    .insert(chatTurns)
    .values({
      channelId: input.channelId,
      userId: input.userId,
      requestId: input.requestId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
    })
    .onConflictDoNothing({
      target: [chatTurns.userId, chatTurns.requestId],
    })
    .returning();

  if (created) return { turn: created, created: true };

  const existing = await getChatTurnByRequest({
    userId: input.userId,
    requestId: input.requestId,
  });
  if (!existing) {
    throw new Error("Could not load an idempotent chat turn after conflict");
  }
  return { turn: existing, created: false };
}

/**
 * Reserve an idempotent turn and persist its triggering user message in one
 * transaction. A retry can therefore never attach to a running turn whose
 * timeline message was lost between separate writes.
 */
export async function createOrGetChatTurnWithUserMessage(input: {
  turn: {
    channelId: string;
    userId: string;
    requestId: string;
    userMessageId: string;
    assistantMessageId: string;
  };
  userMessage: typeof messages.$inferInsert;
}): Promise<{ turn: DurableChatTurn; created: boolean }> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(chatTurns)
      .values(input.turn)
      .onConflictDoNothing({
        target: [chatTurns.userId, chatTurns.requestId],
      })
      .returning();

    if (created) {
      await tx.insert(messages).values(input.userMessage);
      return { turn: created, created: true };
    }

    const [existing] = await tx
      .select()
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.userId, input.turn.userId),
          eq(chatTurns.requestId, input.turn.requestId)
        )
      )
      .limit(1);
    if (!existing) {
      throw new Error("Could not load an idempotent chat turn after conflict");
    }
    return { turn: existing, created: false };
  });
}

export async function getChatTurnByRequest(input: {
  userId: string;
  requestId: string;
}): Promise<DurableChatTurn | undefined> {
  return db.query.chatTurns.findFirst({
    where: and(
      eq(chatTurns.userId, input.userId),
      eq(chatTurns.requestId, input.requestId)
    ),
  });
}

export async function getChatTurnForUser(input: {
  turnId: string;
  userId: string;
}): Promise<DurableChatTurn | undefined> {
  return db.query.chatTurns.findFirst({
    where: and(
      eq(chatTurns.id, input.turnId),
      eq(chatTurns.userId, input.userId)
    ),
  });
}

export async function getChatTurnEvents(input: {
  turnId: string;
  afterSeq?: number;
}): Promise<DurableChatTurnEvent[]> {
  return db.query.chatTurnEvents.findMany({
    where:
      input.afterSeq === undefined
        ? eq(chatTurnEvents.turnId, input.turnId)
        : and(
            eq(chatTurnEvents.turnId, input.turnId),
            gt(chatTurnEvents.seq, input.afterSeq)
          ),
    orderBy: (events, { asc }) => [asc(events.seq)],
  });
}

/**
 * Atomically reserve the next sequence then write its immutable event. This is
 * intentionally transactional: reconnect clients never observe duplicate or
 * skipped sequence numbers even when a cancellation races a final frame.
 */
export async function appendChatTurnEvent(input: {
  turnId: string;
  type: string;
  payload: Record<string, unknown>;
  eventId?: string;
}): Promise<DurableChatTurnEvent> {
  return db.transaction(async (tx) => {
    const [turn] = await tx
      .update(chatTurns)
      .set({
        lastEventSeq: sql`${chatTurns.lastEventSeq} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(chatTurns.id, input.turnId))
      .returning({ seq: chatTurns.lastEventSeq });
    if (!turn) throw new Error("Chat turn not found while appending event");

    const [event] = await tx
      .insert(chatTurnEvents)
      .values({
        turnId: input.turnId,
        seq: turn.seq,
        eventId: input.eventId ?? randomUUID(),
        type: input.type,
        payload: input.payload,
      })
      .returning();
    if (!event) throw new Error("Could not persist chat turn event");
    return event;
  });
}

export async function finishChatTurn(input: {
  turnId: string;
  status: "completed" | "failed" | "cancelled";
  error?: string;
}): Promise<void> {
  await db
    .update(chatTurns)
    .set({
      status:
        input.status === "completed"
          ? ChatTurnStatus.COMPLETED
          : input.status === "cancelled"
            ? ChatTurnStatus.CANCELLED
            : ChatTurnStatus.FAILED,
      error: input.error,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(chatTurns.id, input.turnId));
}

export async function requestChatTurnCancellation(input: {
  turnId: string;
  userId: string;
}): Promise<DurableChatTurn | undefined> {
  const [turn] = await db
    .update(chatTurns)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(
      and(
        eq(chatTurns.id, input.turnId),
        eq(chatTurns.userId, input.userId),
        eq(chatTurns.status, ChatTurnStatus.RUNNING)
      )
    )
    .returning();
  return turn;
}
