/**
 * The session gate in front of the main `/trpc` mount.
 *
 * Every `/trpc/*` request needs a Kratos session, except calls to the public
 * procedures below (health probes, first-admin setup, invite preview and
 * CP-relayed accept).
 *
 * The skip is decided on the procedure list tRPC will EXECUTE, parsed the way
 * `@trpc/server` 11's fetch adapter parses it (`fetchRequestHandler`: the raw,
 * undecoded `URL.pathname`, endpoint and slashes trimmed; `resolveResponse`:
 * a batch path is split on ","), and only when EVERY procedure is public,
 * matched by exact name or namespace prefix. It used to test the raw path for
 * a substring, so `/trpc/health.x,n8nActions.createEntity?batch=1` (batching
 * is on by default) skipped the session and reached a session-only procedure.
 * We split on "," even without `?batch=1`: a comma path is then one unknown
 * procedure (404), so asking for a session there costs nothing.
 *
 * Tests: `trpc-session-gate.test.ts` (real session middleware + real adapter).
 */

import type { MiddlewareHandler } from "hono";

/** Router namespaces whose every procedure is public. */
export const PUBLIC_TRPC_NAMESPACES = ["health", "setup"] as const;

/** Single public procedures inside otherwise session-only routers. */
export const PUBLIC_TRPC_PROCEDURES: ReadonlySet<string> = new Set([
  "workspaces.previewInvite",
]);

const trimSlashes = (p: string): string =>
  p.replace(/^\//, "").replace(/\/$/, "");

/** The procedure paths tRPC will run for this URL (batch paths split on ","). */
export function trpcProcedurePaths(url: string, endpoint = "/trpc"): string[] {
  const pathname = trimSlashes(new URL(url, "http://pod.invalid").pathname);
  return trimSlashes(pathname.slice(trimSlashes(endpoint).length)).split(",");
}

function isPublicProcedure(procedurePath: string): boolean {
  if (PUBLIC_TRPC_PROCEDURES.has(procedurePath)) return true;
  return PUBLIC_TRPC_NAMESPACES.some((ns) =>
    procedurePath.startsWith(`${ns}.`)
  );
}

/** True only when EVERY procedure the request runs is public. */
export function isPublicTrpcRequest(url: string, endpoint = "/trpc"): boolean {
  const paths = trpcProcedurePaths(url, endpoint);
  return paths.length > 0 && paths.every(isPublicProcedure);
}

/** `app.use("/trpc/*", trpcSessionGate(authMiddleware))`. */
export function trpcSessionGate(auth: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicTrpcRequest(c.req.url)) return next();
    return auth(c, next);
  };
}
