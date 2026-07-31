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
 * `/api/chat/stream` `Authorization: Bearer` scheme, which differs from the
 * interactive client's `X-API-Key` + circuit breaker.
 *
 * The timeouts USED to be two hardcoded `60_000` literals here. They now come
 * from `isCallBudgetMs()` (is-call-budget.ts) — see that module for why 60s was
 * wrong and what replaced it — and every failure is funnelled through
 * `describeISFailure` / `describeISHttpError` so the resulting message names
 * which side gave up, after how long, against what budget, at what payload size.
 */

import { drainISChatStream } from "./is-chat-stream.js";
import type { DrainISChatStreamResult } from "./is-chat-stream.js";
import {
  isCallBudgetMs,
  describeISFailure,
  describeISHttpError,
} from "./is-call-budget.js";
import type { ISCallContext } from "./is-call-budget.js";

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
  /**
   * LLM scheduling priority for the IS FairSemaphore.
   * Headless / background workers SHOULD pass `"background"` so live chat keeps
   * interactive slots. Omitted = IS default (interactive).
   */
  priority?: "interactive" | "background";
  /** Optional customer email for IS LLM tier resolution (owner/pricing). */
  customerEmail?: string;
  /**
   * When true, collect `step` frames into the result (for metadata.aiSteps).
   * Default false — session-recap and other text-only callers stay unchanged.
   */
  collectSteps?: boolean;
}

/**
 * POST a headless chat turn to the IS `/api/chat/stream` and drain the SSE to
 * its final text. Shares the ONE SSE parser (drainISChatStream) with every other
 * consumer; owns only the fetch + Bearer auth + `agentTurn` budget abort +
 * HTTP-status check.
 *
 * Throws an ATTRIBUTED error on a non-OK / body-less response and on an
 * abort/network failure (see `describeISFailure`) — the caller no longer has to
 * guess which side hung up. Returns the drained
 * `{ text, error, steps? }` so the caller keeps its own logging / empty-reply
 * handling. `steps` is only present when `payload.collectSteps` is true.
 */
export async function requestHeadlessChatText(
  serviceUrl: string,
  serviceApiKey: string,
  payload: HeadlessChatRequest
): Promise<DrainISChatStreamResult> {
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
    // Background headless work yields FairSemaphore slots to live chat when set.
    ...(payload.priority ? { priority: payload.priority } : {}),
    ...(payload.customerEmail ? { customerEmail: payload.customerEmail } : {}),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (serviceApiKey) {
    headers["Authorization"] = `Bearer ${serviceApiKey}`;
  }

  const endpoint = `${serviceUrl}/api/chat/stream`;
  const budgetMs = isCallBudgetMs("agentTurn");
  // payloadChars = the SERIALIZED body length (uniform across call sites) — for a
  // chat turn the body is dominated by `query`, so this is the size variable an
  // operator actually wants when a turn times out.
  const ctx: ISCallContext = {
    kind: "agentTurn",
    endpoint,
    payloadChars: body.length,
    startedAt: Date.now(),
    budgetMs,
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(budgetMs),
    });
  } catch (err) {
    // Abort (we hung up) vs network (nobody answered) — the message says which.
    throw describeISFailure(ctx, err);
  }

  if (!res.ok || !res.body) {
    // Body-less 200 is an IS-side contract break, not a transport failure —
    // report it on the IS side with an explicit note so it isn't read as a 200.
    const detail = res.ok ? "OK response carried no body" : await readBody(res);
    throw describeISHttpError(ctx, res.status, res.statusText, detail);
  }

  return drainISChatStream(res, {
    collectSteps: payload.collectSteps === true,
  });
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

/** Best-effort error-body read — never let a body read failure mask the real
 *  HTTP failure we are trying to report. */
async function readBody(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

/**
 * POST a command step to the IS `/api/tasks/execute` and return its JSON result.
 * Owns the fetch + `X-API-Key` auth + `command` budget abort + HTTP-status
 * check; the caller keeps its own error logging by catching the throw.
 *
 * Throws an ATTRIBUTED error (side + elapsed + budget + endpoint + payload size)
 * on both a non-OK response and an abort/network failure.
 */
export async function requestTaskExecute(
  serviceUrl: string,
  serviceApiKey: string,
  payload: HeadlessTaskExecuteRequest
): Promise<Record<string, unknown>> {
  const endpoint = `${serviceUrl}/api/tasks/execute`;
  const budgetMs = isCallBudgetMs("command");
  const body = JSON.stringify({
    taskId: payload.taskId,
    action: payload.action,
    context: payload.context,
    userId: payload.userId,
    workspaceId: payload.workspaceId,
  });
  const ctx: ISCallContext = {
    kind: "command",
    endpoint,
    payloadChars: body.length,
    startedAt: Date.now(),
    budgetMs,
  };

  // Kept as an explicit AbortController + clearTimeout (rather than
  // AbortSignal.timeout) to preserve this caller's prior behavior: the timer is
  // released the moment headers arrive, so a slow BODY read is not aborted.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": serviceApiKey,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw describeISFailure(ctx, err);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw describeISHttpError(
      ctx,
      response.status,
      response.statusText,
      await readBody(response)
    );
  }

  return (await response.json()) as Record<string, unknown>;
}
