/**
 * Every answer on the main `/trpc` mount is a tRPC response.
 *
 * Middlewares in front of the tRPC adapter refuse with plain JSON: the edge
 * CORS (403 `BROWSER_ORIGIN_NOT_APPROVED`), the request size limit (413), the
 * pod-edge rate limit (429), the session gate (401/503) and the AI limit
 * (429). `@trpc/client` 11 cannot parse that body: it throws "Unable to
 * transform response from server" with the status only on `meta.response`, so
 * clients retried a 401 three times and showed protocol text (incidents
 * 2026-10-31 and 2026-11-02).
 *
 * `trpcEnvelope(router)` is mounted on `/trpc/*` BEFORE every other
 * middleware. It awaits the whole chain, then looks at the answer. One the
 * tRPC adapter produced (`markTrpcAnswer`) goes out untouched. Any other one
 * with a status tRPC has a code for is rebuilt by `@trpc/server`'s own
 * `resolveResponse` with that error (its `error` option: every call fails with
 * it before any procedure is looked up or its input read): batch-aware, shaped
 * by the router's errorFormatter, serialized with its transformer. Kept from
 * the refusal: the status, the human message, and every header but
 * content-type/length (WWW-Authenticate, Retry-After, RateLimit, CORS). Who
 * gets through is unchanged: only the body is rebuilt.
 *
 * Left as they were: a HEAD/OPTIONS answer (tRPC answers HEAD 204 and serves
 * neither), a status with no tRPC code, and every route outside `/trpc`.
 *
 * Tests: `trpc-refusal.test.ts` (real @trpc/client + superjson); apps/api
 * `trpc-refusal.test.ts` (the real edge chain).
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  TRPCError,
  type AnyTRPCRouter,
  type TRPC_ERROR_CODE_KEY,
} from "@trpc/server";
import { getHTTPStatusCodeFromError, resolveResponse } from "@trpc/server/http";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";

/**
 * The most procedures one batched `/trpc` request may name. Without it an
 * unauthenticated `/trpc/a,a,a…?batch=1` URL of 16 KB was answered with ~8k
 * error shapes. Pass it to every `fetchRequestHandler`, and as `maxItems` (or
 * less) to a client's `httpBatchLink`: tRPC refuses a bigger batch whole
 * (400), every call of it. 200 is above any real client's batch (a GET batch
 * that size already meets URL-length limits).
 */
export const TRPC_MAX_BATCH_SIZE = 200;

const trimSlashes = (p: string): string =>
  p.replace(/^\//, "").replace(/\/$/, "");

/**
 * The path `fetchRequestHandler` hands tRPC for a `/trpc` URL: the raw, still
 * encoded pathname, endpoint and slashes trimmed (@trpc/server 11).
 */
export function trpcPath(url: string): string {
  const pathname = trimSlashes(new URL(url, "http://pod.invalid").pathname);
  return trimSlashes(pathname.slice("trpc".length));
}

/** HTTP status → tRPC code, inverted from tRPC's own code → status map. */
const TRPC_CODE_BY_STATUS = new Map<number, TRPC_ERROR_CODE_KEY>(
  (Object.keys(TRPC_ERROR_CODES_BY_KEY) as TRPC_ERROR_CODE_KEY[]).map(
    (code) => [getHTTPStatusCodeFromError(new TRPCError({ code })), code]
  )
);

const TRPC_ANSWERED = "trpcAnswered";

/** The tRPC adapter calls it on the answer it returns. */
export function markTrpcAnswer(c: Context): void {
  c.set(TRPC_ANSWERED as never, true as never);
}

/** The refusal's own words: `message`, else `details`, else `error`. */
async function refusalMessage(refusal: Response): Promise<string> {
  const text = await refusal
    .clone()
    .text()
    .catch(() => "");
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["message", "details", "error"]) {
      const value = body?.[key];
      if (typeof value === "string") return value;
    }
  } catch {
    if (text) return text;
  }
  return refusal.statusText || `HTTP ${refusal.status}`;
}

async function asTrpcError(
  c: Context,
  refusal: Response,
  code: TRPC_ERROR_CODE_KEY,
  router: AnyTRPCRouter
): Promise<Response> {
  const headers = new Headers();
  refusal.headers.forEach((value, key) => {
    if (key !== "content-type" && key !== "content-length") {
      headers.append(key, value);
    }
  });
  return resolveResponse({
    router,
    req: c.req.raw,
    path: trpcPath(c.req.url),
    error: new TRPCError({ code, message: await refusalMessage(refusal) }),
    maxBatchSize: TRPC_MAX_BATCH_SIZE,
    createContext: async () => ({}),
    // No `info`: tRPC could not read the request at all (a batch over the
    // limit, an unsupported content-type), and its own 4xx says why.
    responseMeta: ({ info }) =>
      info ? { status: refusal.status, headers } : { headers },
  });
}

/** `app.use("/trpc/*", trpcEnvelope(appRouter))`, before every other middleware. */
export function trpcEnvelope(router: AnyTRPCRouter): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.get(TRPC_ANSWERED as never)) return;
    if (c.req.method !== "GET" && c.req.method !== "POST") return;
    const refusal = c.res;
    const code = TRPC_CODE_BY_STATUS.get(refusal.status);
    if (!code) return;
    const res = await asTrpcError(c, refusal, code, router);
    // Unset first: Hono's `res` setter copies the previous response's
    // headers over the new one, which would replace tRPC's `vary`.
    c.res = undefined;
    c.res = res;
  };
}
