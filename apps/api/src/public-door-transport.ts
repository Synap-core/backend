/**
 * TRANSPORT for the credentialless public doors (`/api/hub/public/*`, Sites W3).
 *
 * Mounted FIRST in `index.ts` — outside the credentialed pod-edge CORS, which
 * skips these paths through the same predicate — so a public door's CORS can
 * never be widened into a credentialed one, and an unknown browser origin is
 * never refused with `BROWSER_ORIGIN_NOT_APPROVED`.
 *
 * The policy, and why each line:
 *   - `Access-Control-Allow-Origin: *`. Never the reflected Origin: with `*` a
 *     browser REFUSES a credentialed request by spec, so even a future stray
 *     `Allow-Credentials` would be inert.
 *   - `Access-Control-Allow-Credentials` is DELETED from every response here,
 *     whoever set it downstream.
 *   - `Access-Control-Allow-Headers: Content-Type` only. No Authorization,
 *     Cookie or X-Session-Token: a public door never reads a credential, and a
 *     browser cannot even attach one cross-origin after preflight.
 *   - Methods GET, POST, OPTIONS. A preflight is answered here with 204 and
 *     never reaches the rate limiter, auth or a handler.
 *   - `Cache-Control: no-cache` on reads (store, but revalidate every time): the
 *     global GET default (`private, max-age=60, swr=30`) would let a browser
 *     keep showing an UNSHARED page for up to 90 s. Writes keep `no-store`.
 *   - `Set-Cookie` is stripped: a public response never sets ambient state.
 *   - Body ceiling 16 KB on anything with a body, enforced on the STREAM
 *     (`hono/body-limit`), so a chunked upload with no Content-Length is cut
 *     too (the global `requestSizeLimit` only reads Content-Length).
 *
 * An `Authorization` or `Cookie` header on the request changes nothing: this
 * middleware never reads them, hub auth skips the prefix before reading any
 * credential, the rate key is IP-only, and idempotency never caches without a
 * principal. Guard: `public-doors.tripwire.test.ts` drives the real chain.
 */
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isPublicDoorPath } from "@synap/api/public-doors";

export const PUBLIC_DOOR_MAX_BODY_BYTES = 16 * 1024;

export const PUBLIC_DOOR_ALLOW_METHODS = "GET, POST, OPTIONS";
export const PUBLIC_DOOR_ALLOW_HEADERS = "Content-Type";

function applyPublicDoorHeaders(headers: Headers, method: string): void {
  headers.delete("Access-Control-Allow-Credentials");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", PUBLIC_DOOR_ALLOW_METHODS);
  headers.set("Access-Control-Allow-Headers", PUBLIC_DOOR_ALLOW_HEADERS);
  // ETag is not CORS-safelisted; expose it so a viewer can revalidate.
  headers.set("Access-Control-Expose-Headers", "ETag");
  headers.set("Access-Control-Max-Age", "600");
  headers.delete("Set-Cookie");
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    headers.set("Cache-Control", "no-cache");
  }
}

const limitBody = bodyLimit({
  maxSize: PUBLIC_DOOR_MAX_BODY_BYTES,
  onError: (c: Context) => c.json({ error: "Payload too large" }, 413),
});

export const publicDoorTransport: MiddlewareHandler = async (c, next) => {
  if (!isPublicDoorPath(c.req.path)) return next();

  const method = c.req.method.toUpperCase();
  if (method === "OPTIONS") {
    const preflight = new Response(null, { status: 204 });
    applyPublicDoorHeaders(preflight.headers, method);
    return preflight;
  }

  if (method === "GET" || method === "HEAD") {
    await next();
  } else {
    const limited = await limitBody(c, next);
    // `next` must resolve to void: assign a 413 instead of returning it.
    if (limited instanceof Response) c.res = limited;
  }

  // Re-seat the response so its headers are mutable whatever produced it
  // (Hono's `res` setter copies it into a fresh instance), then impose the
  // policy LAST — after every inner middleware has had its say.
  c.res = c.res;
  applyPublicDoorHeaders(c.res.headers, method);
};
