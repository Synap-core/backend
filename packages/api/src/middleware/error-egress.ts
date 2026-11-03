/**
 * 5xx error-egress sanitizer — the ONE door for what a server fault may tell a client.
 *
 * WHY THIS EXISTS (and why it is a middleware, not 265 handler edits):
 * a 5xx body leaves this process through two very different paths and the
 * leak lived on both.
 *
 *   1. THROWN errors → `app.onError`, which wraps a driver error via
 *      `toSynapError()` into `InternalServerError(msg, { originalError, stack })`.
 *      The handler used to spread `context` unconditionally, so `originalError`
 *      + `stack` shipped to the client in production.
 *   2. RETURNED errors → ~265 hub-REST handlers do
 *      `return c.json({ error: err instanceof Error ? err.message : "…" }, 500)`.
 *      Those never reach `onError` at all. With Drizzle >= 0.44 the caught
 *      error is a `DrizzleQueryError` whose message is literally
 *      `Failed query: ${sql}\nparams: ${params}` — i.e. the full statement,
 *      the whole access-control predicate, and every bound parameter
 *      (including the caller's user id). That is what `GET /api/hub/entities/<non-uuid>`
 *      returned in production.
 *
 * Fixing (2) at each call site is whack-a-mole: handler #266 re-opens it. The
 * enforceable invariant is at the boundary — nothing with a 5xx status leaves
 * this process carrying a body we did not author. Hono's `compose()` sets
 * `context.res` from `onError` at the frame that caught the throw, so an outer
 * middleware's `await next()` observes BOTH paths' responses. One door.
 *
 * What survives sanitization: the status, the machine-readable `code` (clients
 * branch on it), an `errorId` that is also written to the server log so a
 * report can be traced back to the real stack, and `causeUrl`, where a pod
 * admin reads that cause. What does not: any message the handler wrote.
 *
 * THE CAUSE, KEPT (founder ask 2026-11-02, errorId a74f6adc): this door is the
 * one place that sees every REST 5xx, thrown or returned, so it is also where
 * the fault is described (`describeFault`: the original's name, message,
 * stack and cause chain, a query's bound params cut) and stored in
 * `server_faults` under the errorId the client gets
 * (`services/server-faults/record.ts`). A THROWN fault is read from Hono's
 * `c.error`, the original error, never the wrapper `onError` made; a RETURNED
 * one from what its body said. It is stored in development too.
 *
 * EXEMPTIONS (deliberate, each justified):
 *  - development (`nodeEnv === "development"`) — full detail is the point.
 *  - tRPC endpoints — tRPC owns its own envelope (a batch ARRAY of
 *    `{ error: { json: … } }`). Its errorFormatter (`init-trpc.ts`) applies
 *    the same rule there: in production an INTERNAL_SERVER_ERROR carries
 *    {@link SERVER_FAULT_MESSAGE} and an `errorId` that is logged, never the
 *    thrown message or a stack. Rewriting that body here would break
 *    `TRPCClientError` parsing in every client for no security gain.
 *  - non-JSON bodies (SSE streams, HTML) — nothing to reshape, and consuming a
 *    stream to inspect it would break it.
 *
 * 4xx is untouched on purpose: validation errors legitimately carry field-level
 * detail and clients render it.
 */

import { randomUUID } from "crypto";
import type { MiddlewareHandler } from "hono";
import { redactSecretPath } from "./redact-secret-path.js";
import { describeFault } from "../services/server-faults/describe-fault.js";
import {
  faultCauseUrl,
  recordServerFault,
} from "../services/server-faults/record.js";

/** What a client is told about a server fault, on REST and on tRPC alike. */
export const SERVER_FAULT_MESSAGE =
  "An unexpected server error occurred. Quote errorId when reporting it.";

/** Paths whose 5xx envelope is owned by another protocol (see EXEMPTIONS). */
function ownsItsOwnErrorEnvelope(path: string): boolean {
  return path.startsWith("/trpc/") || path.startsWith("/api/hub/trpc");
}

export function sanitizeErrorEgress(opts: {
  isDev: boolean;
  /** pino logger — kept structural so this module owns no logger dependency. */
  log: { error: (obj: unknown, msg: string) => void };
}): MiddlewareHandler {
  return async (c, next) => {
    await next();

    const status = c.res.status;
    if (status < 500 || status > 599) return;
    if (ownsItsOwnErrorEnvelope(c.req.path)) return;
    if (!(c.res.headers.get("content-type") ?? "").includes("application/json"))
      return;

    let raw: string;
    try {
      raw = await c.res.clone().text();
    } catch {
      // Unclonable / already-consumed body — leave it alone rather than risk
      // truncating a response we cannot read.
      return;
    }

    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = undefined;
    }

    const errorId =
      typeof parsed?.errorId === "string" ? parsed.errorId : randomUUID();
    // The path is redacted: a public share / form / calendar token IS the
    // capability, and a 5xx on that door must not copy it into the log.
    const path = redactSecretPath(c.req.path);

    // The ORIGINAL error when one was thrown (`c.error`, set by Hono before
    // `onError` ran), else what the returned body said.
    const fault = describeFault(
      c.error ?? {
        name: typeof parsed?.code === "string" ? parsed.code : "ServerError",
        message:
          typeof parsed?.message === "string"
            ? parsed.message
            : typeof parsed?.error === "string"
              ? parsed.error
              : raw,
      }
    );
    const get = c.get as (key: string) => unknown;
    const caller = (key: string) => {
      const v = get.call(c, key);
      return typeof v === "string" && v ? v : null;
    };
    void recordServerFault({
      errorId,
      door: "rest",
      method: c.req.method,
      path,
      status,
      userId: caller("userId"),
      agentUserId: caller("agentUserId"),
      fault,
    });

    if (opts.isDev) return;

    // Ops correlates by errorId; `fault` is the cause, flat.
    opts.log.error(
      {
        errorId,
        path,
        method: c.req.method,
        statusCode: status,
        fault,
        originalBody: raw,
      },
      `5xx body redacted before egress: ${fault.name}: ${fault.message.split("\n")[0]}`
    );

    c.res = new Response(
      JSON.stringify({
        // `error` is NOT preserved: on the ~265 hub-REST handlers it holds the
        // raw driver message — the leak itself. `code` is a closed vocabulary
        // clients branch on, so it survives.
        error: "ServerError",
        code:
          typeof parsed?.code === "string"
            ? parsed.code
            : "INTERNAL_SERVER_ERROR",
        message: SERVER_FAULT_MESSAGE,
        errorId,
        // Where a pod admin reads the cause: a link; the content stays behind
        // the pod-admin floor (services/server-faults/read.ts).
        causeUrl: faultCauseUrl(errorId, c.req.url),
      }),
      { status, headers: { "content-type": "application/json" } }
    );
    // Hono's `set res` copies the previous response's headers onto the new one
    // (content-type excluded). A stale content-length would truncate the new,
    // shorter body.
    try {
      c.res.headers.delete("content-length");
    } catch {
      /* immutable headers — c.json() never sets content-length, so this is defensive */
    }
  };
}
