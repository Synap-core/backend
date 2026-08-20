/**
 * ONE door from an AI/IS failure to the words a user reads.
 *
 * The rule this module exists to enforce: **never assert a cause the code did
 * not verify, and never recommend an action that cannot work.** The bug it
 * replaces told users "the AI service is recovering from a temporary overload,
 * please try again shortly" while the real failure was `HTTP 402 Insufficient
 * Balance` — the LLM provider was out of credit. No amount of retrying could
 * ever have fixed that, and nothing was recovering from anything.
 *
 * Classification is EVIDENCE-ONLY: an HTTP status carried on the error, a
 * provider error code, or an unambiguous token in the error text. When there is
 * no evidence, the class is `unknown` and the copy SAYS so — it does not guess.
 *
 * Relationship to `classifyDispatchFailure` (connectors/external-dispatch.ts):
 * that is the sibling classifier for *connector dispatch* failures, which
 * always arrive with a known HTTP status and whose classes drive reconnect /
 * connect affordances in the browser. This one starts from a thrown `unknown`,
 * and needs the distinction that one does not carry — billing/quota exhaustion
 * (operator must act) vs. a retryable outage. It is deliberately a LEAF module
 * (no DB, no connector imports) so the MCP handlers and the chat send path can
 * import it without pulling the dispatch graph in. Keep the two precedence
 * orders in sync in spirit: no-credit and credential-rejection outrank
 * transient, because calling a 402 "temporary" is the exact defect above.
 */

/**
 * What the evidence actually showed.
 *
 *   quota            — 402 / insufficient balance / credit or billing exhausted
 *   auth             — 401/403, credentials rejected by the AI service
 *   rate_limit       — 429
 *   timeout          — the call was aborted on our deadline
 *   circuit          — our client refused to call out (breaker open after repeated failures)
 *   upstream         — 5xx from the AI service
 *   bad_request      — 4xx: the request itself was rejected as invalid
 *   invalid_response — the call succeeded but the payload was unusable
 *   unknown          — no usable evidence. Say exactly that.
 */
import type { IsFailureEnvelope } from "@synap-core/types";

export type AiFailureClass =
  | "quota"
  | "plan_quota"
  | "cancelled"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "circuit"
  | "upstream"
  | "bad_request"
  | "invalid_response"
  | "unknown";

/**
 * WIRE CONTRACT — the stable `code` emitted on `CHAT_STREAM_ERROR` alongside
 * `error` and `retryable`. The browser reads it to decide affordances (notably
 * whether a Retry button may be offered at all); it is NOT display text, so it
 * must stay stable even if the copy is reworded.
 *
 * One code per class we can actually EVIDENCE — no code exists for a state we
 * cannot distinguish. `upstream_error`, `bad_request` and `invalid_response`
 * are additions beyond the first six agreed with the app side; they are the
 * remaining classes this module can prove, and collapsing them into `unknown`
 * would throw away evidence we hold.
 */
export type AiFailureCode =
  | "provider_no_credit"
  | "quota_exhausted"
  | "cancelled"
  | "provider_auth"
  | "rate_limited"
  | "timeout"
  | "circuit_open"
  | "upstream_error"
  | "bad_request"
  | "invalid_response"
  | "unknown";

export interface AiFailureDescription {
  readonly class: AiFailureClass;
  /** Stable wire code — see AiFailureCode. */
  readonly code: AiFailureCode;
  /** Can the SAME request succeed on a retry, with no human action? */
  readonly retryable: boolean;
  /** Does a human operator have to change something before it can ever work? */
  readonly needsOperator: boolean;
  /** User-facing text. Never asserts an unverified cause. */
  readonly message: string;
}

/** Extract an HTTP status from whatever shape the failure arrived in. */
function extractStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const bag = error as Record<string, unknown>;
    for (const key of ["status", "statusCode"]) {
      const value = bag[key];
      if (typeof value === "number" && value >= 100 && value <= 599) {
        return value;
      }
    }
    const response = bag.response;
    if (typeof response === "object" && response !== null) {
      const nested = (response as Record<string, unknown>).status;
      if (typeof nested === "number") return nested;
    }
  }
  // Textual fallback, but only where the number is UNAMBIGUOUSLY a status: the
  // shapes our own clients throw ("Intelligence Hub error: 402 Payment
  // Required", "IS answer HTTP 503", "status=429"). A bare 3-digit number
  // anywhere in a message is NOT treated as a status — that would invent
  // evidence, which is the thing this module exists to prevent.
  const text = messageOf(error);
  const match = /(?:\berror:\s*|\bHTTP\s*|\bstatus[=:]\s*)(\d{3})\b/i.exec(
    text
  );
  if (match) {
    const parsed = Number(match[1]);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }
  return undefined;
}

/**
 * A short, already-vetted reason carried on the error by the caller.
 *
 * `intelligence-hub-client` attaches `.detail` ONLY for the Intelligence
 * Service's own validation envelope, whose messages are our own strings. It is
 * never a raw upstream body, so it is safe to put in front of a user — and it
 * is the difference between "invalid" and "turnContext may not contain more
 * than 20 items".
 */
function detailOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>).detail;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/** A provider error code, when one was carried on the error. */
function extractCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const bag = error as Record<string, unknown>;
    for (const key of ["code", "errorCode", "error_code", "name"]) {
      const value = bag[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

/**
 * The Intelligence Service's own failure codes → our classes. EXPLICIT, so a
 * code we have never seen resolves to `unknown` (and says so) instead of being
 * string-matched onto whichever class looks closest.
 *
 * Note `insufficient_credit` and `quota_exhausted` are DIFFERENT things — one
 * is an empty wallet, the other a spent allowance — and our copy tells the
 * operator to do different things about them, so they do not share a class.
 * `cancelled` is not a fault at all; it is here because the IS can emit it.
 */
const IS_CODE_TO_CLASS: Record<string, AiFailureClass> = {
  insufficient_credit: "quota",
  quota_exhausted: "plan_quota",
  auth: "auth",
  rate_limit: "rate_limit",
  timeout: "timeout",
  circuit_open: "circuit",
  provider_error: "upstream",
  cancelled: "cancelled",
  unknown: "unknown",
};

/** Read the IS failure envelope off an error, wherever it was attached. */
function extractFailureEnvelope(error: unknown): IsFailureEnvelope | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const bag = error as Record<string, unknown>;
  // Carried on `.failure` — how send-message attaches it to the Error it
  // throws for an SSE `error` frame. This is the ONLY unambiguous shape.
  if (typeof bag.failure === "object" && bag.failure !== null) {
    return bag.failure as IsFailureEnvelope;
  }
  // A bare envelope passed straight in. It must carry `retryable` to qualify:
  // a plain Error with a `.code` (e.g. a provider's "insufficient_quota", or
  // Node's "ECONNREFUSED") is NOT an IS envelope, and reading it as one would
  // send a perfectly classifiable failure to `unknown`.
  if (typeof bag.retryable === "boolean" && typeof bag.code === "string") {
    return bag as IsFailureEnvelope;
  }
  return undefined;
}

/**
 * Map a failure to its class using evidence only.
 *
 * Precedence is deliberate: quota and auth are checked BEFORE the transient
 * families, so a 402 whose body happens to mention a timeout is still reported
 * as "an operator must act", never as "try again".
 */
export function classifyAiFailure(error: unknown): AiFailureClass {
  // BEST evidence first: the IS's structured envelope. Its `code` is mapped
  // through an explicit table — never string-matched — and an unrecognised
  // code falls to `unknown` rather than guessing the nearest neighbour.
  const envelope = extractFailureEnvelope(error);
  if (envelope?.code) {
    return IS_CODE_TO_CLASS[envelope.code] ?? "unknown";
  }

  const status = extractStatus(error);
  const text = `${messageOf(error)} ${extractCode(error)}`;

  // quota — the provider will not serve us until someone pays. NOT retryable.
  if (
    status === 402 ||
    /insufficient[_ ](?:balance|quota|credit)|payment required|quota exceeded|out of credit|billing/i.test(
      text
    )
  ) {
    return "quota";
  }

  // auth — credentials rejected. NOT retryable by the user.
  if (
    status === 401 ||
    status === 403 ||
    /unauthorized|forbidden|invalid[_ ]api[_ ]key|authentication failed|credential/i.test(
      text
    )
  ) {
    return "auth";
  }

  if (status === 429 || /rate[_ ]?limit|too many requests/i.test(text)) {
    return "rate_limit";
  }

  // circuit — OUR client declined to call out. Checked before timeout because
  // the breaker message is our own and unambiguous.
  if (/circuit open/i.test(text)) return "circuit";

  if (
    status === 408 ||
    /\baborted?\b|timed? ?out|timeout|ETIMEDOUT/i.test(text)
  ) {
    return "timeout";
  }

  if (status !== undefined && status >= 500) return "upstream";

  // Transport-level failures are outages of the same shape as a 5xx.
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(text)) {
    return "upstream";
  }

  if (status !== undefined && status >= 400) return "bad_request";

  return "unknown";
}

const COPY: Record<
  AiFailureClass,
  {
    code: AiFailureCode;
    retryable: boolean;
    needsOperator: boolean;
    message: string;
  }
> = {
  quota: {
    code: "provider_no_credit",
    retryable: false,
    needsOperator: true,
    message:
      "The AI provider refused the request because the account is out of credit (HTTP 402). Retrying will not help — an operator has to top up the AI provider account first.",
  },
  plan_quota: {
    code: "quota_exhausted",
    retryable: false,
    needsOperator: true,
    message:
      "The AI provider says this account's quota is used up. Retrying will not help — an operator has to raise the quota or wait for it to reset.",
  },
  cancelled: {
    code: "cancelled",
    retryable: true,
    needsOperator: false,
    message: "The request was cancelled before the AI service finished.",
  },
  auth: {
    code: "provider_auth",
    retryable: false,
    needsOperator: true,
    message:
      "The AI provider rejected our credentials. Retrying will not help — an operator has to fix the AI service credentials first.",
  },
  rate_limit: {
    code: "rate_limited",
    retryable: true,
    needsOperator: false,
    message: "The AI provider is rate-limiting us right now.",
  },
  timeout: {
    code: "timeout",
    retryable: true,
    needsOperator: false,
    message:
      "The AI service did not answer before the request deadline, so the turn was cut off.",
  },
  circuit: {
    code: "circuit_open",
    retryable: true,
    needsOperator: false,
    message:
      "Recent calls to the AI service failed, so this pod stopped calling it for a moment. The underlying failure is in the pod logs.",
  },
  upstream: {
    code: "upstream_error",
    retryable: true,
    needsOperator: false,
    message: "The AI service returned a server error.",
  },
  bad_request: {
    code: "bad_request",
    retryable: false,
    needsOperator: true,
    // Deliberately does NOT name an actor. A 4xx on the AI call can come from
    // the AI provider OR from the Intelligence Service's own request
    // validation, and at this layer we cannot tell which — the 2026-08-20
    // Companion outage was our own zod schema, reported to users as "the AI
    // service rejected" it. Naming an unverified culprit is exactly what this
    // module exists to prevent. When a reason IS available it is appended by
    // `describeAiFailure` below.
    message:
      "The request was rejected as invalid before the AI could answer. Retrying the same request will not help — this one needs a fix on our side.",
  },
  invalid_response: {
    code: "invalid_response",
    retryable: false,
    needsOperator: true,
    message:
      "The AI service answered, but the answer could not be read. Retrying the same request may produce the same result — the raw response is in the pod logs.",
  },
  // `unknown` defaults `retryable: false` DELIBERATELY. `retryable` drives the
  // browser's Retry button, and a button is an invitation: offering one we
  // cannot evidence will work is the same defect as inventing a cause. The
  // user can always send the message again themselves, so the cost of the
  // conservative default is one lost shortcut, not a lost recovery.
  unknown: {
    code: "unknown",
    retryable: false,
    needsOperator: false,
    message:
      "The call to the AI service failed, and we do not yet know why. The raw error is in the pod logs.",
  },
};

/**
 * Turn a failure — or an already-known class — into user-facing text.
 *
 * `reference` must be an id that ALREADY exists in the caller's scope (a
 * clientRequestId, a turn requestId). This module never mints one.
 */
export function describeAiFailure(
  failure: unknown,
  options: { reference?: string | null } = {}
): AiFailureDescription {
  const failureClass =
    typeof failure === "string" && failure in COPY
      ? (failure as AiFailureClass)
      : classifyAiFailure(failure);
  const copy = COPY[failureClass];
  const envelope = extractFailureEnvelope(failure);

  // TRUST the IS's `retryable` when it sent one — it sees things we cannot
  // (their finding: a 429 whose body says "insufficient balance" is NOT a
  // retryable rate limit). Only ever narrows or widens by evidence, never by
  // our guess. A retryable class the IS calls non-retryable becomes
  // non-retryable, and the copy drops its retry suggestion to match.
  const retryable =
    typeof envelope?.retryable === "boolean"
      ? envelope.retryable
      : copy.retryable;

  // `retryAfterSeconds` is real evidence: say WHEN instead of "shortly".
  const retryAfter =
    retryable && typeof envelope?.retryAfterSeconds === "number"
      ? ` Try again in about ${Math.max(1, Math.round(envelope.retryAfterSeconds))}s.`
      : "";
  const reference = options.reference
    ? ` Reference: ${options.reference}.`
    : "";
  // Advice is DERIVED from `retryable`, never baked into the cause sentence —
  // so when the IS overrides a normally-retryable class to non-retryable, the
  // words stop inviting a retry too. The non-retryable classes carry their own
  // "retrying will not help" in the cause; this only speaks when the verdict
  // came from the envelope rather than the class.
  const advice = retryable
    ? retryAfter || " Sending again may work."
    : copy.retryable
      ? " The AI service reports that retrying will not help."
      : "";

  // The concrete reason, when the caller vetted one. Placed BEFORE the advice
  // and reference so the sentence reads cause-then-consequence, and only for
  // classes where a caller-supplied reason is meaningful — a quota or auth
  // failure already states its own cause exactly.
  const detail = detailOf(failure);
  const because =
    detail && (failureClass === "bad_request" || failureClass === "unknown")
      ? ` Reason: ${detail}.`
      : "";

  return {
    class: failureClass,
    code: copy.code,
    retryable,
    needsOperator: copy.needsOperator,
    message: `${copy.message}${because}${advice}${reference}`,
  };
}

/** Convenience for call sites that only need the sentence. */
export function aiFailureMessage(
  failure: unknown,
  options: { reference?: string | null } = {}
): string {
  return describeAiFailure(failure, options).message;
}
