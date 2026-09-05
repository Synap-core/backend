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
 *
 * A headless failure has no live tab to stream an error frame to (unlike
 * channels.sendMessage's SSE `turnEnvelope("error")`), so once retries are
 * exhausted it raises an `agent.task_failed` notification instead — see
 * `notifyA2AIFailure`.
 */

import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import {
  requestHeadlessChatText,
  isRetryableHubError,
} from "@synap/intelligence-client";
import {
  and,
  chatTurns,
  ChatTurnStatus,
  db,
  eq,
  gte,
  messages,
  persistAssistantReply,
} from "@synap/database";
import {
  notifications,
  NotificationCategory,
  NotificationPriority,
} from "@synap/database/schema";

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

/**
 * pg-boss job options for A2AI response trigger.
 * `singletonKey` is set per-send to userMessageId (see trigger-auto-respond)
 * so concurrent double-enqueue cannot schedule two IS calls for one message.
 */
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
 * Same collapse window as the `agent.task_failed` producer in
 * `packages/api/src/routers/hub-protocol/rest/events.ts` (one flaky agent
 * must not spam every retry). Duplicated as a literal, not imported: that
 * producer lives in @synap/api, and @synap/jobs cannot depend on @synap/api
 * (api → jobs is the existing direction — see the file header).
 */
const AGENT_FAILURE_RENOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 1h

/**
 * Surface a terminal (no-more-retries) headless-turn failure as a durable
 * `agent.task_failed` notification — the SAME registered type the
 * interactive/automation paths already raise for an agent failure, so the
 * bell panel renders it with its existing icon/title/actions. This is the
 * ONLY notification door @synap/jobs can reach: `NotificationService.create`
 * (routing prefs, quiet hours, realtime emit) lives in @synap/api and is
 * unreachable here, so — matching the existing precedent in
 * `utils/proactive-post.ts` and `workers/steps/output.ts` — this inserts the
 * row directly and skips that service's preference/quiet-hours gating.
 *
 * Never throws: a failed turn is already recorded in `chat_turns`; losing the
 * notification on top of that must not turn a handled failure into a thrown
 * one. Cooldown-gated per (scope, agentKey) so a burst of identical failures
 * collapses into one bell entry instead of one per attempt.
 */
async function notifyA2AIFailure(input: {
  userId: string;
  workspaceId: string | null;
  agentType: string;
  agentUserId?: string;
  turnId: string;
  errorMessage: string;
}): Promise<void> {
  try {
    const agentKey = input.agentUserId ?? input.agentType;
    const groupKey = input.workspaceId
      ? `${input.workspaceId}:agent.task_failed:${agentKey}`
      : `pod:${input.userId}:agent.task_failed:${agentKey}`;
    const cooldownFloor = new Date(
      Date.now() - AGENT_FAILURE_RENOTIFY_COOLDOWN_MS
    );

    const [recent] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, "agent.task_failed"),
          eq(notifications.groupKey, groupKey),
          gte(notifications.createdAt, cooldownFloor)
        )
      )
      .limit(1);
    if (recent) return;

    await db.insert(notifications).values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      type: "agent.task_failed",
      category: NotificationCategory.AI,
      priority: NotificationPriority.HIGH,
      title: `${input.agentType} encountered an error`,
      body: input.errorMessage,
      sourceType: "agent",
      sourceId: input.turnId,
      groupKey,
    });
  } catch (err) {
    logger.warn(
      { err, turnId: input.turnId },
      "A2AI failure notification could not be written (non-fatal)"
    );
  }
}

/**
 * CAS-claim a previously-failed turn as running again so a pg-boss retry can
 * re-invoke the model. Returns true only if THIS worker won the claim.
 *
 * Mirrors `reopenChatTurn` in api/services/chat-turns/chat-turn-store.ts (D5).
 * Kept local: @synap/jobs must not import @synap/api (api → jobs dependency).
 */
async function reopenHeadlessChatTurn(turnId: string): Promise<boolean> {
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

  // Crash recovery first: assistant may already be durable while the turn
  // never finished (persist succeeded, finish failed). Covers running + failed.
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

    // Concurrent job while turn is still running with no assistant yet —
    // do not double-call IS (singletonKey usually prevents; ledger guard).
    if (turn.status === ChatTurnStatus.RUNNING) {
      logger.info(
        { channelId, userMessageId, turnId: turn.id },
        "A2AI turn already running — skipping"
      );
      return;
    }

    if (turn.status === ChatTurnStatus.FAILED) {
      const claimed = await reopenHeadlessChatTurn(turn.id);
      if (!claimed) {
        logger.info(
          { channelId, userMessageId, turnId: turn.id },
          "A2AI reopen lost CAS race — skipping"
        );
        return;
      }
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
    // Only rethrow when a retry could actually change the outcome. pg-boss
    // retries a thrown job (`retryLimit: 3`), so rethrowing a 4xx turned one
    // impossible request into FOUR — four identical rejections, four log
    // entries, and a user error delayed by the whole chain. The turn is
    // already recorded as failed above, so returning here loses nothing.
    if (!isRetryableHubError(err)) {
      logger.warn(
        { channelId, userMessageId, turnId: turn.id, detail },
        "A2AI hub call refused the request — not retrying (a replay cannot succeed)"
      );
      // Terminal — no retry will follow, so this is the one chance to surface it.
      // Status is verified (the transport stamped it), so name it honestly;
      // for anything unclassified, stay neutral about which side is at fault.
      await notifyA2AIFailure({
        userId,
        workspaceId,
        agentType,
        agentUserId,
        turnId: turn.id,
        errorMessage:
          typeof (err as { status?: unknown })?.status === "number"
            ? `The AI service rejected the request (${(err as { status: number }).status}).`
            : "The request to the AI service failed.",
      });
      return;
    }
    if (job.retryCount >= A2AI_TRIGGER_JOB_OPTIONS.retryLimit!) {
      // Last attempt exhausted — this failure will not be retried again.
      await notifyA2AIFailure({
        userId,
        workspaceId,
        agentType,
        agentUserId,
        turnId: turn.id,
        errorMessage: "The request to the AI service failed.",
      });
    }
    throw err; // transient — let pg-boss retry
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
    if (job.retryCount >= A2AI_TRIGGER_JOB_OPTIONS.retryLimit!) {
      await notifyA2AIFailure({
        userId,
        workspaceId,
        agentType,
        agentUserId,
        turnId: turn.id,
        errorMessage: detail,
      });
    }
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
    if (job.retryCount >= A2AI_TRIGGER_JOB_OPTIONS.retryLimit!) {
      // The model DID answer here — this is a Synap-side save failure, not an
      // agent/IS fault, so say so rather than blaming "an error" on the agent.
      await notifyA2AIFailure({
        userId,
        workspaceId,
        agentType,
        agentUserId,
        turnId: turn.id,
        errorMessage: `The response could not be saved: ${detail}`,
      });
    }
    throw err;
  }
}
