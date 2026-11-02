/**
 * Refusals in front of the main `/trpc` mount, answered as tRPC errors.
 *
 * The session gate (apps/api `trpc-session-gate.ts` → `appSessionMiddleware`
 * → `authMiddleware`) and the AI rate limit (`trpc-ai-rate-limit.ts`) refuse
 * with plain JSON (`{ error: "Unauthorized" }`, 401/429/503). `@trpc/client`
 * 11 cannot parse that body: it throws "Unable to transform response from
 * server" with the status only on `meta.response`, so clients retried a 401
 * three times and showed protocol text (incident 2026-10-31).
 *
 * `trpcRefusals(router)` wraps such a middleware. When it answers without
 * calling `next`, with a status tRPC has a code for, the answer is rebuilt by
 * `@trpc/server`'s own `resolveResponse` with that error (its `error` option:
 * every call fails with it before any procedure is looked up or its input
 * read): batch-aware, shaped by the router's errorFormatter, serialized with
 * its transformer. Kept from the refusal: the status, the human message, and
 * every header but content-type/length (WWW-Authenticate, Retry-After,
 * RateLimit, CORS). Who gets through is unchanged: only the body is rebuilt.
 *
 * Left as they were: a HEAD/OPTIONS refusal (tRPC answers HEAD 204 and serves
 * neither), a status with no tRPC code, and every route outside `/trpc`.
 *
 * Imports only hono and @trpc/server: apps/api reads it (and `trpcPath`, for
 * the session gate and the AI limit) via `@synap/api/trpc-refusal`.
 *
 * Tests: `trpc-refusal.test.ts` (real @trpc/client + superjson).
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  TRPCError,
  type AnyTRPCRouter,
  type TRPC_ERROR_CODE_KEY,
} from "@trpc/server";
import { getHTTPStatusCodeFromError, resolveResponse } from "@trpc/server/http";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";

const trimSlashes = (p: string): string =>
  p.replace(/^\//, "").replace(/\/$/, "");

/**
 * The path `fetchRequestHandler` hands tRPC for this URL: the raw, still
 * encoded pathname, endpoint and slashes trimmed (@trpc/server 11).
 */
export function trpcPath(url: string, endpoint = "/trpc"): string {
  const pathname = trimSlashes(new URL(url, "http://pod.invalid").pathname);
  return trimSlashes(pathname.slice(trimSlashes(endpoint).length));
}

/** HTTP status → tRPC code, inverted from tRPC's own code → status map. */
const TRPC_CODE_BY_STATUS = new Map<number, TRPC_ERROR_CODE_KEY>(
  (Object.keys(TRPC_ERROR_CODES_BY_KEY) as TRPC_ERROR_CODE_KEY[]).map(
    (code) => [getHTTPStatusCodeFromError(new TRPCError({ code })), code]
  )
);

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
  router: AnyTRPCRouter,
  endpoint: string
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
    path: trpcPath(c.req.url, endpoint),
    error: new TRPCError({ code, message: await refusalMessage(refusal) }),
    createContext: async () => ({}),
    responseMeta: () => ({ status: refusal.status, headers }),
  });
}

/** `app.use("/trpc/*", trpcRefusals(appRouter)(middleware))`. */
export function trpcRefusals(router: AnyTRPCRouter, endpoint = "/trpc") {
  return (middleware: MiddlewareHandler): MiddlewareHandler =>
    async (c, next) => {
      let passed = false;
      const out = await middleware(c, async () => {
        passed = true;
        await next();
      });
      if (passed) return out;
      // A refusal is returned (`return c.json(…)`) or assigned (`c.res = …`,
      // the AI rate limit). `c.res` is read only when assigned: its getter
      // creates an empty 200.
      const refusal =
        out instanceof Response ? out : c.finalized ? c.res : undefined;
      const code = refusal && TRPC_CODE_BY_STATUS.get(refusal.status);
      if (!refusal || !code || !["GET", "POST"].includes(c.req.method)) {
        return out;
      }
      const res = await asTrpcError(c, refusal, code, router, endpoint);
      // Unset first: Hono's `res` setter copies the previous response's
      // headers over the new one, which would replace tRPC's `vary`.
      c.res = undefined;
      c.res = res;
    };
}
