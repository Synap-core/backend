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
 * avoid a circular dependency between @synap/api and @synap/jobs. The SSE parse
 * and the assistant-reply persist are the SHARED primitives (drainISChatStream
 * in @synap/intelligence-client, persistAssistantReply in @synap/database) that
 * the interactive `channels.sendMessage` path also uses — one reader, one chain.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import { drainISChatStream } from "@synap/intelligence-client";
import { persistAssistantReply } from "@synap/database";

const logger = createLogger({ module: "a2ai-response-trigger" });

export interface A2AIResponseTriggerData {
  channelId: string;
  userMessageId: string;
  content: string;
  userId: string;
  workspaceId: string;
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

/**
 * Call the intelligence hub and return the full response text. Uses plain fetch
 * (no IntelligenceHubClient) to avoid the api↔jobs circular dep, but shares the
 * SSE parser with every other consumer via drainISChatStream.
 */
async function callIntelligenceHub(
  serviceUrl: string,
  serviceApiKey: string,
  payload: {
    query: string;
    threadId: string;
    userId: string;
    workspaceId: string;
    agentType: string;
    sourceMessageId: string;
    focusSessionId?: string | null;
    agentUserId?: string;
  }
): Promise<string> {
  const body = JSON.stringify({
    query: payload.query,
    threadId: payload.threadId,
    userId: payload.userId,
    workspaceId: payload.workspaceId,
    agentId: "orchestrator",
    agentType: payload.agentType,
    sourceMessageId: payload.sourceMessageId,
    focusSessionId: payload.focusSessionId,
    agentUserId: payload.agentUserId,
    // REQUIRED: without stream:true the IS chat-stream takes its non-streaming
    // branch (plain JSON), so the SSE reader finds no frames and the reply is
    // dropped as empty. With stream:true the IS emits SSE (content deltas + the
    // authoritative `complete` event), which drainISChatStream consumes.
    stream: true,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (serviceApiKey) {
    headers["Authorization"] = `Bearer ${serviceApiKey}`;
  }

  const res = await fetch(`${serviceUrl}/api/chat/stream`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Intelligence hub returned ${res.status}`);
  }

  const { text: finalText, error: streamError } = await drainISChatStream(res);

  logger.info(
    { finalLen: finalText.length, streamError: streamError || undefined },
    "A2AI SSE drained"
  );
  if (streamError && !finalText) {
    logger.error(
      { streamError },
      "A2AI IS stream returned error with no content"
    );
  }

  return finalText;
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

  let fullContent: string;
  try {
    fullContent = await callIntelligenceHub(serviceUrl, serviceApiKey, {
      query: content,
      threadId: channelId,
      userId,
      workspaceId,
      agentType,
      sourceMessageId: userMessageId,
      focusSessionId: job.data.focusSessionId,
      agentUserId,
    });
  } catch (err) {
    logger.error(
      { err, channelId, userMessageId },
      "A2AI intelligence hub call failed"
    );
    throw err; // let pg-boss retry
  }

  if (!fullContent) {
    logger.warn(
      { channelId, userMessageId },
      "A2AI response was empty — skipping persist"
    );
    return;
  }

  const { assistantId } = await persistAssistantReply({
    channelId,
    userMessageId,
    triggerContent: content,
    content: fullContent,
    userId,
    metadata: { serviceId, a2ai: true, sourceAgentUserId },
  });

  logger.info(
    { channelId, assistantId, serviceId },
    "A2AI response persisted"
  );
}
