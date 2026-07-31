import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  ChatTurnStatus,
  chatTurnEvents,
  chatTurns,
  db,
  messages,
} from "@synap/database";

// Re-export for call-site convenience; UUID shaping lives in a sibling module
// so raw hash construction is not co-located with messages inserts
// (message-hash-one-formula tripwire).
export { stableUuidFromSeed } from "./stable-uuid-from-seed.js";

export type DurableChatTurn = typeof chatTurns.$inferSelect;
export type DurableChatTurnEvent = typeof chatTurnEvents.$inferSelect;

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

/**
 * CAS-claim a previously-failed turn back to running so the same requestId can
 * re-invoke the model. Clears error + completedAt.
 *
 * Returns true only if THIS caller won the claim (row was still `failed`).
 * Concurrent retries that lose must treat the turn as in_progress — not re-run IS.
 * Shared by Discord agent-turn, external chat, openai-compat, and (mirrors)
 * headless A2AI retries.
 */
export async function reopenChatTurn(turnId: string): Promise<boolean> {
  const [row] = await db
    .update(chatTurns)
    .set({
      status: ChatTurnStatus.RUNNING,
      error: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(chatTurns.id, turnId), eq(chatTurns.status, ChatTurnStatus.FAILED))
    )
    .returning({ id: chatTurns.id });
  return row != null;
}

/**
 * Pure claim policy for durable turns under the same requestId (D5).
 *
 * - completed → skip (idempotent success)
 * - running → in_progress (another worker owns it)
 * - failed with no useful assistant → reopen_and_run
 * - failed/cancelled with useful assistant → skip_with_assistant
 * - cancelled without assistant → skip (intentional abort; do not auto-reopen)
 * - newly created → run
 */
export type ChatTurnClaimAction =
  | "run"
  | "skip_completed"
  | "in_progress"
  | "reopen_and_run"
  | "skip_with_assistant"
  | "skip_cancelled";

export function decideChatTurnClaimAction(input: {
  created: boolean;
  status: string;
  hasUsefulAssistant: boolean;
}): ChatTurnClaimAction {
  if (input.created) return "run";
  if (input.status === ChatTurnStatus.COMPLETED) return "skip_completed";
  if (input.status === ChatTurnStatus.RUNNING) return "in_progress";
  if (input.status === ChatTurnStatus.CANCELLED) {
    return input.hasUsefulAssistant ? "skip_with_assistant" : "skip_cancelled";
  }
  // failed (or any unexpected terminal)
  if (input.hasUsefulAssistant) return "skip_with_assistant";
  return "reopen_and_run";
}

/** Non-empty assistant body counts as useful (partial apology text still useful). */
export function isUsefulAssistantContent(
  content: string | null | undefined
): boolean {
  return typeof content === "string" && content.trim().length > 0;
}

/**
 * Look up whether the turn's allocated assistant message already has useful
 * content. Best-effort: missing row → false.
 */
export async function hasUsefulAssistantForTurn(
  assistantMessageId: string
): Promise<boolean> {
  const row = await db.query.messages.findFirst({
    where: eq(messages.id, assistantMessageId),
    columns: { content: true },
  });
  return isUsefulAssistantContent(row?.content);
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
