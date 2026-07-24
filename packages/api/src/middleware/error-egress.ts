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
 * branch on it), and an `errorId` that is also written to the server log so a
 * report can be traced back to the real stack. What does not: any message the
 * handler wrote.
 *
 * EXEMPTIONS (deliberate, each justified):
 *  - development (`nodeEnv === "development"`) — full detail is the point.
 *  - tRPC endpoints — tRPC owns its own envelope (a batch ARRAY of
 *    `{ error: { json: … } }`), and `packages/api/src/trpc.ts` already replaces
 *    the message with a generic string outside development while
 *    `getErrorShape` drops `stack` outside development. Rewriting that body
 *    would break `TRPCClientError` parsing in every client for no security gain.
 *  - non-JSON bodies (SSE streams, HTML) — nothing to reshape, and consuming a
 *    stream to inspect it would break it.
 *
 * 4xx is untouched on purpose: validation errors legitimately carry field-level
 * detail and clients render it.
 */

import { randomUUID } from "crypto";
import type { MiddlewareHandler } from "hono";

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

    if (opts.isDev) return;

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

    // The ONLY place the original body survives. Ops correlates by errorId.
    opts.log.error(
      {
        errorId,
        path: c.req.path,
        method: c.req.method,
        statusCode: status,
        originalBody: raw,
      },
      "5xx body redacted before egress"
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
        message:
          "An unexpected server error occurred. Quote errorId when reporting it.",
        errorId,
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
