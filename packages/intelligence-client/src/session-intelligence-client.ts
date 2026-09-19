/**
 * Backend → IS session-intelligence calls (synap-intelligence-service
 * routes/session-intelligence/*: `/api/session-title`, `/api/playbook-choice`,
 * `/api/judge-criteria`).
 *
 * ONE transport for the three narrow session questions, in the shape of the
 * headless transports: per-call `{ serviceUrl, apiKey }` (the caller resolves
 * the service via `getDefaultActiveService`), a `generation` budget, and
 * ATTRIBUTED failures via `describeISFailure` / `describeISHttpError`. It
 * THROWS on failure — "the IS could not answer" and "the IS answered nothing"
 * are different facts, and only the caller knows which fallback each one gets.
 */

import {
  isCallBudgetMs,
  describeISFailure,
  describeISHttpError,
} from "./is-call-budget.js";
import type { ISCallContext } from "./is-call-budget.js";

/**
 * POST a JSON body to one session-intelligence route and return its JSON.
 * Throws an attributed error on a network failure, budget abort or non-OK
 * status.
 */
export async function postSessionIntelligence<T>(
  serviceUrl: string,
  serviceApiKey: string,
  path: `/api/${string}`,
  payload: unknown
): Promise<T> {
  const endpoint = `${serviceUrl}${path}`;
  const budgetMs = isCallBudgetMs("generation");
  const body = JSON.stringify(payload);
  const ctx: ISCallContext = {
    kind: "generation",
    endpoint,
    payloadChars: body.length,
    startedAt: Date.now(),
    budgetMs,
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Same fallback the interactive client applies to an empty key (the
        // env default service carries none of its own).
        "X-API-Key":
          serviceApiKey || process.env.INTELLIGENCE_HUB_API_KEY || "",
      },
      body,
      signal: AbortSignal.timeout(budgetMs),
    });
  } catch (err) {
    throw describeISFailure(ctx, err);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw describeISHttpError(ctx, res.status, res.statusText, detail);
  }
  return (await res.json()) as T;
}

/** Body of `POST /api/session-title`. */
export interface SessionTitleRequest {
  /** The session's goal (the IS clips it). */
  goal: string;
  /** ≤ 2000 chars: first messages / output labels (early) or the closing summary (close). */
  context?: string;
  phase: "early" | "close";
  language?: string;
}

/** Mirror of the IS `SessionTitleResult`. `title` null = no usable name. */
export interface SessionTitleResult {
  title: string | null;
  decider: "llm";
  model?: string;
}

/** Longest `context` the route reads; longer is clipped here, not refused there. */
const SESSION_TITLE_CONTEXT_MAX = 2000;

/**
 * Ask the IS for a session name. The answer is RAW model output after the
 * IS's own cleanup — the caller must still pass it through the canonical
 * `sanitizeGeneratedTitle` before storing it.
 */
export function requestSessionTitle(
  serviceUrl: string,
  serviceApiKey: string,
  payload: SessionTitleRequest
): Promise<SessionTitleResult> {
  return postSessionIntelligence<SessionTitleResult>(
    serviceUrl,
    serviceApiKey,
    "/api/session-title",
    {
      ...payload,
      ...(payload.context
        ? { context: payload.context.slice(0, SESSION_TITLE_CONTEXT_MAX) }
        : {}),
    }
  );
}
