/**
 * Headless Intelligence-Service transports.
 *
 * The SSOT for the raw HTTP calls that non-interactive (pg-boss worker) callers
 * make to the Intelligence Service. These used to be hand-rolled `fetch`
 * integrations inlined in `@synap/jobs` workers (a2ai-response-trigger,
 * automation-executor). Centralizing them here keeps IS transport in ONE
 * package — the same package that owns the SSE parser (`iterateISChatStream` /
 * `drainISChatStream`).
 *
 * These are deliberately SEPARATE from the `IntelligenceHubClient` class: they
 * take per-call `{ serviceUrl, apiKey }` (resolved from the DB via
 * getDefaultActiveService / pre-resolved in the pg-boss job payload, never env)
 * and they preserve each caller's EXACT prior wire behavior — including the
 * `/api/chat/stream` `Authorization: Bearer` scheme and the 60s worker timeouts,
 * which differ from the interactive client's `X-API-Key` + circuit breaker.
 */

import { drainISChatStream } from "./is-chat-stream.js";

/** Body fields for a headless `/api/chat/stream` turn (a2ai worker). */
export interface HeadlessChatRequest {
  query: string;
  threadId: string;
  userId: string;
  /**
   * Omitted from the IS body when undefined (personal channels), matching the
   * interactive path — the IS then runs the turn in personal context.
   */
  workspaceId?: string;
  agentType: string;
  sourceMessageId: string;
  focusSessionId?: string | null;
  agentUserId?: string;
}

/**
 * POST a headless chat turn to the IS `/api/chat/stream` and drain the SSE to
 * its final text. Shares the ONE SSE parser (drainISChatStream) with every other
 * consumer; owns only the fetch + Bearer auth + 60s abort + HTTP-status check.
 *
 * Throws `Intelligence hub returned <status>` on a non-OK / body-less response;
 * transport errors (abort/network) propagate. Returns the drained
 * `{ text, error }` so the caller keeps its own logging / empty-reply handling.
 */
export async function requestHeadlessChatText(
  serviceUrl: string,
  serviceApiKey: string,
  payload: HeadlessChatRequest
): Promise<{ text: string; error: string | null }> {
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

  return drainISChatStream(res);
}

/** Body for a headless `/api/tasks/execute` command run (automation executor). */
export interface HeadlessTaskExecuteRequest {
  taskId: string;
  action: string;
  context: Record<string, unknown>;
  /** The owning principal the IS attributes its pod writes to. */
  userId: string;
  workspaceId: string;
}

/**
 * POST a command step to the IS `/api/tasks/execute` and return its JSON result.
 * Owns the fetch + `X-API-Key` auth + 60s abort + HTTP-status check; the caller
 * keeps its own error logging by catching the throw.
 *
 * Throws `IS returned <status>: <statusText>` on a non-OK response.
 */
export async function requestTaskExecute(
  serviceUrl: string,
  serviceApiKey: string,
  payload: HeadlessTaskExecuteRequest
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000); // 60s timeout for commands

  const response = await fetch(`${serviceUrl}/api/tasks/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": serviceApiKey,
    },
    body: JSON.stringify({
      taskId: payload.taskId,
      action: payload.action,
      context: payload.context,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
    }),
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`IS returned ${response.status}: ${response.statusText}`);
  }

  return (await response.json()) as Record<string, unknown>;
}
