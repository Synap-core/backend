/**
 * A2AI Response Trigger Worker
 *
 * Handles async A2AI response generation with retry semantics.
 * Queued via pg-boss when an external agent posts to an A2AI channel,
 * replacing the previous fire-and-forget approach.
 *
 * Retry policy: 3 attempts, 10s delay between retries, expires after 5 minutes.
 *
 * Self-contained: accepts pre-resolved service URL + API key in job data to
 * avoid a circular dependency between @synap/api and @synap/jobs. The IS
 * transport (fetch + Bearer auth + SSE drain) and the assistant-reply persist
 * are the SHARED primitives (requestHeadlessChatText in
 * @synap/intelligence-client, persistAssistantReply in @synap/database) that the
 * interactive `channels.sendMessage` path also builds on — one reader, one chain.
 *
 * Phase 2 (headless durable turns): mirrors channels.sendMessage's chat_turns
 * lifecycle without requiring a clientRequestId from Discord/threads. The
 * stable requestId is the trigger userMessageId (UUID) so pg-boss retries
 * reattach instead of double-creating. On success the assistant row gets
 * metadata.aiSteps when the stream carried step frames; on failure the turn
 * is finished as `failed` with a durable error string.
 */

import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import { requestHeadlessChatText } from "@synap/intelligence-client";
import {
  and,
  chatTurns,
  ChatTurnStatus,
  db,
  eq,
  messages,
  persistAssistantReply,
} from "@synap/database";

const logger = createLogger({ module: "a2ai-response-trigger" });

export interface A2AIResponseTriggerData {
  channelId: string;
  userMessageId: string;
  content: string;
  userId: string;
  /** null for PERSONAL (pod-scoped) channels — the IS runs personal context. */
  workspaceId: string | null;
  agentType: string;
  sourceAgentUserId: string;
  /** Active focus session ID — forwarded to the IS so the agent runs
   *  session-aware and tags all hub calls with X-Session-Id. */
  focusSessionId?: string | null;
  /** Pre-resolved intelligence service URL */
  serviceUrl: string;
  /** Pre-resolved API key (decrypted) for the intelligence service */
  serviceApiKey: string;
  /** Pre-resolved service ID for attribution */
  serviceId: string;
  /** Per-human AI agent user ID */
  agentUserId?: string;
}

/** pg-boss job options for A2AI response trigger */
export const A2AI_TRIGGER_JOB_OPTIONS: PgBoss.SendOptions = {
  retryLimit: 3,
  retryDelay: 10,
  expireInSeconds: 300,
};

export const A2AI_TRIGGER_QUEUE = "a2ai-response-trigger";

type DurableHeadlessTurn = typeof chatTurns.$inferSelect;

/**
 * Reserve (or reattach to) the durable chat_turn for this headless response.
 * requestId = userMessageId so retries of the same trigger never double-create.
 * User message is already persisted by the post path — we only claim the turn.
 */
async function createOrGetHeadlessChatTurn(input: {
  channelId: string;
  userId: string;
  userMessageId: string;
}): Promise<{ turn: DurableHeadlessTurn; created: boolean }> {
  const requestId = input.userMessageId;
  const assistantMessageId = randomUUID();

  const [created] = await db
    .insert(chatTurns)
    .values({
      channelId: input.channelId,
      userId: input.userId,
      requestId,
      userMessageId: input.userMessageId,
      assistantMessageId,
    })
    .onConflictDoNothing({
      target: [chatTurns.userId, chatTurns.requestId],
    })
    .returning();

  if (created) {
    return { turn: created, created: true };
  }

  const [existing] = await db
    .select()
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.userId, input.userId),
        eq(chatTurns.requestId, requestId)
      )
    )
    .limit(1);
  if (!existing) {
    throw new Error(
      "Could not load an idempotent headless chat turn after conflict"
    );
  }
  return { turn: existing, created: false };
}

async function finishHeadlessChatTurn(input: {
  turnId: string;
  status: "completed" | "failed";
  error?: string;
}): Promise<void> {
  await db
    .update(chatTurns)
    .set({
      status:
        input.status === "completed"
          ? ChatTurnStatus.COMPLETED
          : ChatTurnStatus.FAILED,
      // Always write the column so a retry that succeeds clears a prior failure.
      error: input.error ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(chatTurns.id, input.turnId));
}

/**
 * Mark a previously-failed (or interrupted running) turn as running again so a
 * pg-boss retry can re-invoke the model and finish cleanly.
 */
async function reopenHeadlessChatTurn(turnId: string): Promise<void> {
  await db
    .update(chatTurns)
    .set({
      status: ChatTurnStatus.RUNNING,
      error: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(chatTurns.id, turnId));
}

/**
 * Call the intelligence hub and return full response text + optional steps.
 * Delegates the IS transport (fetch + Bearer auth + SSE drain) to the SSOT
 * `requestHeadlessChatText` — no raw fetch here. Headless turns use
 * priority:background so they yield FairSemaphore slots to live chat.
 */
async function callIntelligenceHub(
  serviceUrl: string,
  serviceApiKey: string,
  payload: {
    query: string;
    threadId: string;
    userId: string;
    // Omitted from the IS body when undefined (personal channels), matching
    // the interactive path — the IS then runs the turn in personal context.
    workspaceId?: string;
    agentType: string;
    sourceMessageId: string;
    focusSessionId?: string | null;
    agentUserId?: string;
  }
): Promise<{ text: string; error: string | null; steps: unknown[] }> {
  const {
    text: finalText,
    error: streamError,
    steps,
  } = await requestHeadlessChatText(serviceUrl, serviceApiKey, {
    ...payload,
    priority: "background",
    collectSteps: true,
  });

  logger.info(
    {
      finalLen: finalText.length,
      streamError: streamError || undefined,
      stepCount: steps?.length ?? 0,
    },
    "A2AI SSE drained"
  );
  if (streamError && !finalText) {
    logger.error(
      { streamError },
      "A2AI IS stream returned error with no content"
    );
  }

  return { text: finalText, error: streamError, steps: steps ?? [] };
}

export async function handleA2AIResponseTrigger(
  job: PgBoss.JobWithMetadata<A2AIResponseTriggerData>
): Promise<void> {
  const {
    channelId,
    userMessageId,
    content,
    userId,
    workspaceId,
    agentType,
    serviceUrl,
    serviceApiKey,
    serviceId,
    agentUserId,
    sourceAgentUserId,
  } = job.data;

  logger.info(
    { channelId, userMessageId, retryCount: job.retryCount },
    "A2AI response trigger"
  );

  // Durable turn claim — requestId is the trigger message id (stable across
  // pg-boss retries) so we never double-create a turn for the same intent.
  const { turn, created } = await createOrGetHeadlessChatTurn({
    channelId,
    userId,
    userMessageId,
  });

  if (!created && turn.status === ChatTurnStatus.COMPLETED) {
    logger.info(
      { channelId, userMessageId, turnId: turn.id },
      "A2AI turn already completed — skipping"
    );
    return;
  }

  // Crash recovery: assistant may already be durable while the turn never
  // finished (persist succeeded, finish failed). Don't re-call the model.
  if (!created) {
    const existingAssistant = await db.query.messages.findFirst({
      where: eq(messages.id, turn.assistantMessageId),
      columns: { id: true },
    });
    if (existingAssistant) {
      await finishHeadlessChatTurn({
        turnId: turn.id,
        status: "completed",
      });
      logger.info(
        { channelId, turnId: turn.id, assistantId: turn.assistantMessageId },
        "A2AI assistant already persisted — turn marked completed"
      );
      return;
    }
    if (turn.status !== ChatTurnStatus.RUNNING) {
      await reopenHeadlessChatTurn(turn.id);
    }
  }

  let fullContent: string;
  let streamError: string | null = null;
  let aiSteps: unknown[] = [];
  try {
    const result = await callIntelligenceHub(serviceUrl, serviceApiKey, {
      query: content,
      threadId: channelId,
      userId,
      // null (personal) → undefined so JSON.stringify omits it from the IS body.
      workspaceId: workspaceId ?? undefined,
      agentType,
      sourceMessageId: userMessageId,
      focusSessionId: job.data.focusSessionId,
      agentUserId,
    });
    fullContent = result.text;
    streamError = result.error;
    aiSteps = result.steps;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, channelId, userMessageId, turnId: turn.id },
      "A2AI intelligence hub call failed"
    );
    await finishHeadlessChatTurn({
      turnId: turn.id,
      status: "failed",
      error: detail,
    });
    throw err; // let pg-boss retry
  }

  if (!fullContent) {
    const detail =
      streamError ?? "A2AI response was empty — no content to persist";
    logger.warn(
      { channelId, userMessageId, turnId: turn.id, streamError },
      "A2AI response was empty — finishing turn as failed"
    );
    await finishHeadlessChatTurn({
      turnId: turn.id,
      status: "failed",
      error: detail,
    });
    // Throw so pg-boss can retry transient empty/error streams.
    throw new Error(detail);
  }

  try {
    const { assistantId } = await persistAssistantReply({
      assistantId: turn.assistantMessageId,
      channelId,
      userMessageId,
      triggerContent: content,
      content: fullContent,
      userId,
      metadata: {
        serviceId,
        a2ai: true,
        sourceAgentUserId,
        // Tool/thinking steps from the stream (mirrors channels.sendMessage +
        // Discord agent-turn provenance). Empty array when the stream had none.
        aiSteps,
        intelligenceServiceId: serviceId,
        agentType,
      },
    });

    await finishHeadlessChatTurn({
      turnId: turn.id,
      status: "completed",
    });

    logger.info(
      {
        channelId,
        assistantId,
        serviceId,
        turnId: turn.id,
        stepCount: aiSteps.length,
      },
      "A2AI response persisted"
    );
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "Could not persist the AI response";
    logger.error(
      { err, channelId, userMessageId, turnId: turn.id },
      "A2AI persist failed"
    );
    await finishHeadlessChatTurn({
      turnId: turn.id,
      status: "failed",
      error: detail,
    });
    throw err;
  }
}
