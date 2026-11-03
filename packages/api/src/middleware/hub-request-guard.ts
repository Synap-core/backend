/**
 * Hub request guard: a request that runs too long answers 503, and one key
 * cannot hold more than a few requests on the pod at once (plan "Pod
 * resilience and resource alerts" P4, G8 + G9 step 1; founder, decision
 * 8d8c2fef).
 *
 * WHY: on 3 Nov 2026 one read held the pod's single event loop for ~1.5 h,
 * and every caller waited with it. Nothing bounded how long a Hub REST or MCP
 * request may run, nor how many one key may run at once. The per-minute
 * limits (`utils/hub-protocol-rate-limit.ts`, the edge classes in
 * `apps/api/src/middleware/rate-limit-classes.ts`) count requests STARTED; a
 * key that starts 50 slow requests in one second is inside every one of them.
 *
 * THE TWO RULES, one door for both surfaces (Hub REST `hub-protocol-rest.ts`,
 * MCP `routers/mcp/http-handler.ts`, through {@link runGuarded}):
 *  1. TIMEOUT (G8). A guarded request that has not answered after
 *     {@link hubRequestTimeoutMs} (default 30 s, env
 *     `SYNAP_HUB_REQUEST_TIMEOUT_MS`) answers 503 with code
 *     {@link REQUEST_TIMEOUT}. Its work is NOT cancelled: no AbortSignal is
 *     threaded into the handlers (that would touch every door), so the work
 *     may still finish in the background, and a late failure is logged. A
 *     client retrying a write checks first (an `Idempotency-Key` write replays
 *     the finished answer: the idempotency middleware sits inside this guard).
 *     On the wire the 503 passes the 5xx egress door (`error-egress.ts`), which
 *     keeps `code`, replaces the message and records the fault under an
 *     `errorId`: a pod admin sees which route timed out.
 *  2. IN-FLIGHT LIMIT (G9 step 1). At most {@link hubMaxInFlightPerKey}
 *     (default 8, env `SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY`) counted requests per
 *     API key run at once; the next one answers 429 with `Retry-After: 1` and
 *     code {@link TOO_MANY_IN_FLIGHT}. A slot is released when the WORK
 *     settles, not when a 503 was sent: a key whose requests timed out but
 *     still run keeps holding the pod, so it must not start more. A slot whose
 *     work never settles is force-released after {@link IN_FLIGHT_LEASE_MS},
 *     with a warning. Counters are in memory: one API process today.
 *     Not counted: a request with no API key (a person's browser session, the
 *     IS per-turn delegation) and the pod's own key types
 *     ({@link UNCOUNTED_KEY_TYPES}).
 *
 * EXEMPT ROUTES (never wrapped by the timeout; `__tripwires__/
 * hub-request-guard-exempt.tripwire.test.ts` derives the streaming, waiting
 * and upload routes from the source and holds each one here):
 *  - `stream` and `long_poll`: open by design and idle most of the time. NOT
 *    timed and NOT counted (a few open streams must not lock a key out); the
 *    per-minute limits still bound how often they are opened.
 *  - `upload` and `model` (a model or an outbound call): legitimately longer
 *    than 30 s. NOT timed, but COUNTED: they hold memory and sockets.
 *
 * G9 STEP 2 (not built): a per-key cost/time budget is charged where
 * {@link runGuarded} acquires the slot; see the marked line.
 *
 * Bodies carry no internals: a fixed sentence, the code and the limit.
 */

import type { MiddlewareHandler } from "hono";
import { createLogger } from "@synap-core/core";
import { redactSecretPath } from "./redact-secret-path.js";

const logger = createLogger({ module: "hub-request-guard" });

/** Typed code of the 503 a timed-out request answers. */
export const REQUEST_TIMEOUT = "REQUEST_TIMEOUT";
/** Typed code of the 429 a key over its in-flight limit gets. */
export const TOO_MANY_IN_FLIGHT = "TOO_MANY_IN_FLIGHT";

export const DEFAULT_HUB_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HUB_MAX_IN_FLIGHT_PER_KEY = 8;
/** A slot whose work never settles is released after this, with a warning. */
export const IN_FLIGHT_LEASE_MS = 10 * 60_000;

/** The env keys a deployed pod passes (deploy/docker-compose.yml, env.schema). */
export const HUB_REQUEST_GUARD_ENV = {
  timeoutMs: "SYNAP_HUB_REQUEST_TIMEOUT_MS",
  maxInFlight: "SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY",
} as const;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How long a guarded request may run: its env override, else 30 s. */
export function hubRequestTimeoutMs(): number {
  return positiveIntEnv(
    HUB_REQUEST_GUARD_ENV.timeoutMs,
    DEFAULT_HUB_REQUEST_TIMEOUT_MS
  );
}

/** How many counted requests one key may run at once: env, else 8. */
export function hubMaxInFlightPerKey(): number {
  return positiveIntEnv(
    HUB_REQUEST_GUARD_ENV.maxInFlight,
    DEFAULT_HUB_MAX_IN_FLIGHT_PER_KEY
  );
}

/** Key types that are the pod's own machinery: never counted. */
export const UNCOUNTED_KEY_TYPES: ReadonlySet<string> = new Set([
  "is_internal",
  "system",
]);

// ── What is exempt ────────────────────────────────────────────────────────

export type HubGuardExemption = "stream" | "long_poll" | "upload" | "model";

export interface HubGuardPolicy {
  /** The timeout applies. */
  timed: boolean;
  /** The request takes an in-flight slot. */
  counted: boolean;
}

/** What each exemption means (module header). `null` = an ordinary request. */
export function guardPolicy(
  exemption: HubGuardExemption | null
): HubGuardPolicy {
  if (exemption === null) return { timed: true, counted: true };
  if (exemption === "stream" || exemption === "long_poll")
    return { timed: false, counted: false };
  return { timed: false, counted: true };
}

interface ExemptRoute {
  method: string;
  /** Path relative to the Hub base, `:param` for one segment, `/*` = prefix. */
  path: string;
  kind: HubGuardExemption;
  pattern: RegExp;
}

function exempt(
  method: string,
  path: string,
  kind: HubGuardExemption
): ExemptRoute {
  const prefix = path.endsWith("/*");
  const body = (prefix ? path.slice(0, -2) : path)
    .split("/")
    .map((seg) =>
      seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("/");
  return {
    method,
    path,
    kind,
    pattern: new RegExp(`^${body}${prefix ? "(?:/.*)?" : "/?"}$`),
  };
}

/**
 * The Hub REST routes the timeout never wraps. Hub REST carries no per-route
 * cost metadata yet, so this is the one list; the tripwire derives the
 * stream / long-poll / upload routes from the route files and fails when one
 * is missing here. `model` routes run a model or an outbound call (the REST
 * twins of the MCP tools that declare `openWorldHint`, the edge's AI classes).
 */
export const HUB_REST_EXEMPT_ROUTES: readonly ExemptRoute[] = [
  // stream — SSE (events.ts)
  exempt("GET", "/events/stream", "stream"),
  // long_poll — bounded wait for the person's answer, up to 90 s
  // (services/focus-sessions/wait-for-answers.ts WAIT_MAX_SECONDS)
  exempt("GET", "/focus-sessions/:id/answers/wait", "long_poll"),
  // upload — bytes in the body (entities.ts, capture.ts, box-runs.ts) and the
  // bulk import surface (the edge's `import` class)
  exempt("POST", "/files", "upload"),
  exempt("POST", "/files/uploads", "upload"),
  exempt("POST", "/files/uploads/finalize", "upload"),
  exempt("POST", "/entities/:entityId/source-file", "upload"),
  exempt("POST", "/entities/:entityId/attachments", "upload"),
  exempt("POST", "/box-runs/:id/uploads", "upload"),
  exempt("*", "/import/*", "upload"),
  // model — a model or an outbound call per request
  exempt("POST", "/knowledge/answer", "model"),
  exempt("POST", "/files/:entityId/transcribe", "model"),
  exempt("POST", "/discord/agent-turn", "model"),
  exempt("POST", "/discord/mail-feed/run", "model"),
  exempt("POST", "/discord/event-sync/run", "model"),
  exempt("POST", "/capture/cluster-tabs", "model"),
  exempt("POST", "/capture/structure", "model"),
  exempt("POST", "/capture/draft-process", "model"),
  exempt("POST", "/channels/trigger-ai", "model"),
  exempt("POST", "/capabilities/execute", "model"),
  exempt("POST", "/connectors/tool-execute", "model"),
  exempt("POST", "/automations/:automationId/trigger", "model"),
  exempt("POST", "/playbooks/:id/run", "model"),
  exempt("POST", "/workers/:ruleId/run", "model"),
];

const HUB_BASE = /^\/api\/hub(?:-protocol)?(?=\/|$)/;

/** A Hub REST path relative to its base (`/api/hub` or `/api/hub-protocol`). */
export function hubRelativePath(path: string): string {
  const p = path.split(/[?#]/, 1)[0] || "/";
  return p.replace(HUB_BASE, "") || "/";
}

/** The exemption of a Hub REST request, or null when it is guarded. */
export function classifyHubRestRequest(
  method: string,
  path: string
): HubGuardExemption | null {
  const m = method.toUpperCase();
  const rel = hubRelativePath(path);
  for (const r of HUB_REST_EXEMPT_ROUTES) {
    if ((r.method === "*" || r.method === m) && r.pattern.test(rel))
      return r.kind;
  }
  return null;
}

/** MCP tools that wait by design (a bounded long-poll, up to 90 s). */
export const MCP_LONG_POLL_TOOLS: ReadonlySet<string> = new Set([
  "synap_wait_for_answer",
]);
/** MCP tools that may run a model without declaring `openWorldHint`. */
export const MCP_MODEL_TOOLS: ReadonlySet<string> = new Set(["synap_ask"]);

/**
 * The exemption of one MCP `tools/call`, from the tool's own metadata:
 * `openWorldTools` = the tools that declare `openWorldHint: true`
 * (`openWorldToolNames`, routers/mcp/tools/index.ts).
 */
export function classifyMcpToolCall(
  toolName: string | undefined,
  openWorldTools: ReadonlySet<string>
): HubGuardExemption | null {
  if (!toolName) return null;
  if (MCP_LONG_POLL_TOOLS.has(toolName)) return "long_poll";
  if (MCP_MODEL_TOOLS.has(toolName) || openWorldTools.has(toolName))
    return "model";
  return null;
}

// ── In-flight counters ────────────────────────────────────────────────────

const inFlight = new Map<string, number>();

/** How many counted requests a key runs right now (tests, diagnostics). */
export function inFlightCount(key: string): number {
  return inFlight.get(key) ?? 0;
}

/** Test seam: forget every counter. */
export function resetHubInFlightForTests(): void {
  inFlight.clear();
}

/** Take a slot for `key`; null when the key already holds `max`. */
function acquire(key: string, max: number, route: string): (() => void) | null {
  const n = inFlight.get(key) ?? 0;
  if (n >= max) return null;
  inFlight.set(key, n + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(lease);
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left <= 0) inFlight.delete(key);
    else inFlight.set(key, left);
  };
  const lease = setTimeout(() => {
    logger.warn(
      { route, key, leaseMs: IN_FLIGHT_LEASE_MS },
      "hub in-flight slot released by its lease: the request never settled"
    );
    release();
  }, IN_FLIGHT_LEASE_MS);
  lease.unref?.();
  return release;
}

// ── The one guard ─────────────────────────────────────────────────────────

const TIMED_OUT: unique symbol = Symbol("hub-request-timed-out");

export interface GuardedRequest {
  /** The API key the request is counted against; null = not counted. */
  key: string | null;
  /** `METHOD path` (redacted) or `MCP tools/call <tool>`, for the log. */
  route: string;
  exemption: HubGuardExemption | null;
}

export interface GuardAnswers<T> {
  timedOut: (timeoutMs: number) => T;
  busy: (limit: number) => T;
}

/**
 * Run `work` under the two rules. Answers what `work` answered, or
 * `answers.busy` (over the in-flight limit, `work` never starts) or
 * `answers.timedOut` (past the timeout, `work` keeps running).
 */
export async function runGuarded<T>(
  req: GuardedRequest,
  work: () => Promise<T>,
  answers: GuardAnswers<T>
): Promise<T> {
  const policy = guardPolicy(req.exemption);

  let release: (() => void) | null = null;
  if (policy.counted && req.key) {
    const limit = hubMaxInFlightPerKey();
    release = acquire(req.key, limit, req.route);
    if (!release) {
      logger.warn(
        { route: req.route, key: req.key, limit },
        "hub request refused: the key is over its in-flight limit"
      );
      return answers.busy(limit);
    }
    // G9 step 2 (not built): charge the key's cost/time budget here.
  }

  let running: Promise<T>;
  try {
    running = work();
  } catch (err) {
    release?.();
    throw err;
  }
  if (release) running.then(release, release);

  if (!policy.timed) return running;

  const timeoutMs = hubRequestTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const first = await Promise.race([running, deadline]);
    if (first !== TIMED_OUT) return first;
  } finally {
    clearTimeout(timer);
  }

  logger.warn(
    { route: req.route, key: req.key, timeoutMs },
    "hub request timed out: answered 503, its work may still finish"
  );
  running.catch((err: unknown) =>
    logger.warn(
      { err, route: req.route, key: req.key },
      "hub request failed after it had timed out"
    )
  );
  return answers.timedOut(timeoutMs);
}

// ── Hub REST answers + middleware ─────────────────────────────────────────

/** The 503 body of a timed-out Hub REST request. */
export function hubTimeoutBody(timeoutMs: number) {
  return {
    error: "Request timed out",
    code: REQUEST_TIMEOUT,
    reasonCode: REQUEST_TIMEOUT,
    message:
      `The pod did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
      "The work may still finish: check before retrying a write.",
    timeoutMs,
  };
}

/** The 429 body of a key over its in-flight limit. */
export function hubInFlightBody(limit: number) {
  return {
    error: "Too many requests in flight",
    code: TOO_MANY_IN_FLIGHT,
    reasonCode: TOO_MANY_IN_FLIGHT,
    message:
      `This key already has ${limit} requests running on the pod. ` +
      "Wait for one to finish, then retry.",
    limit,
    scope: "key",
    retryAfter: 1,
  };
}

/** The counted key of an authenticated Hub REST request, or null. */
export function hubRestGuardKey(get: (key: string) => unknown): string | null {
  const apiKeyId = get("apiKeyId");
  if (typeof apiKeyId !== "string" || !apiKeyId) return null;
  const keyType = get("keyType");
  if (typeof keyType === "string" && UNCOUNTED_KEY_TYPES.has(keyType))
    return null;
  return apiKeyId;
}

/**
 * Hub REST: mounted after auth (it needs the key) and before the session and
 * idempotency middleware (`hub-protocol-rest.ts`).
 */
export const hubRequestGuardMiddleware: MiddlewareHandler = async (c, next) => {
  const get = (key: string) => (c.get as (k: string) => unknown).call(c, key);
  return runGuarded<Response | void>(
    {
      key: hubRestGuardKey(get),
      route: `${c.req.method} ${redactSecretPath(c.req.path)}`,
      exemption: classifyHubRestRequest(c.req.method, c.req.path),
    },
    () => next(),
    {
      timedOut: (ms) => c.json(hubTimeoutBody(ms), 503),
      busy: (limit) =>
        c.json(hubInFlightBody(limit), 429, { "Retry-After": "1" }),
    }
  );
};
