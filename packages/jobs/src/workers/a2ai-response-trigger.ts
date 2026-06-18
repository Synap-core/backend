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
 * avoid circular dependency between @synap/api and @synap/jobs.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import { db, eq } from "@synap/database";
import {
  channels,
  messages,
  MessageRole,
  MessageAuthorType,
} from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

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
 * Call the intelligence hub and return the full response text.
 * Uses plain fetch (no IntelligenceHubClient) to avoid circular deps.
 * Attempts streaming first; falls back to non-streaming on error.
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
  },
  onChunk: (chunk: string) => void
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

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const evt = JSON.parse(raw) as { type?: string; content?: string };
        if (evt.type === "chunk" && evt.content) {
          acc += evt.content;
          onChunk(evt.content);
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  return acc;
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
    fullContent = await callIntelligenceHub(
      serviceUrl,
      serviceApiKey,
      {
        query: content,
        threadId: channelId,
        userId,
        workspaceId,
        agentType,
        sourceMessageId: userMessageId,
        focusSessionId: job.data.focusSessionId,
        agentUserId,
      },
      (_chunk) => {
        // Note: streaming chunks are not forwarded from the worker — the A2AI channel
        // response is persisted to DB and the frontend picks it up via subscription.
        // Real-time streaming is only needed for interactive (non-background) chat.
      }
    );
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

  const assistantId = randomUUID();
  const prevHash = createHash("sha256")
    .update(`${userMessageId}${content}`)
    .digest("hex");
  const assistantHash = createHash("sha256")
    .update(`${assistantId}${fullContent}${prevHash}`)
    .digest("hex");

  await db.insert(messages).values({
    id: assistantId,
    channelId,
    role: MessageRole.ASSISTANT,
    authorType: MessageAuthorType.AI_AGENT,
    content: fullContent,
    userId,
    previousHash: prevHash,
    hash: assistantHash,
    metadata: { serviceId, a2ai: true, sourceAgentUserId } as Record<
      string,
      unknown
    > as (typeof messages.$inferInsert)["metadata"],
  });

  await db
    .update(channels)
    .set({ updatedAt: new Date() })
    .where(eq(channels.id, channelId));

  // Note: chat events are emitted by the API layer on DB subscription.
  // The worker only writes to DB — real-time socket events are handled separately.

  logger.info({ channelId, assistantId, serviceId }, "A2AI response persisted");
}
