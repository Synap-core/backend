/**
 * THE PUBLIC DOOR NAMESPACE — one predicate, zero imports (Sites W3).
 *
 * `/api/hub/public/*` (and the `/api/hub-protocol/public/*` alias) is the
 * credentialless surface a browser on ANY origin may call: a published share,
 * later a guest form. Four layers must agree on which paths those are, and they
 * used to be four hand lists that nothing kept aligned:
 *
 *   1. Hub auth skip          (`routers/hub-protocol/_middleware/auth.ts`)
 *   2. Idempotency skip       (`routers/hub-protocol/_middleware/idempotency.ts`)
 *   3. CORS / transport       (`apps/api/src/public-door-transport.ts`, the
 *                              global CORS in `apps/api/src/index.ts`, and
 *                              `rejectsUnapprovedExternalPodApiRequest`)
 *   4. Rate class             (`apps/api/src/middleware/rate-limit-classes.ts`)
 *
 * All of them call {@link isPublicDoorPath}. The NAMESPACE is the contract: a new
 * route under `/public/` joins every layer by existing, not by being remembered
 * (guard: `apps/api/src/public-doors.tripwire.test.ts`).
 *
 * ZERO IMPORTS, on purpose: `apps/api` reads this through the
 * `@synap/api/public-doors` subpath from `rate-limit-classes.ts`, whose header
 * forbids the heavy `@synap/api` graph. Keep it that way.
 *
 * FAIL CLOSED. A path this predicate cannot read unambiguously (dot segments,
 * encoded separators, doubled slashes, backslashes) is NOT public: it falls to
 * the ordinary authenticated, credentialed path, never the other way round.
 */

/** Mounts the hub app is served under (longest first). */
export const PUBLIC_DOOR_MOUNTS = ["/api/hub-protocol", "/api/hub"] as const;

/** The namespace, relative to a hub mount. */
export const PUBLIC_DOOR_PREFIX = "/public/";

/**
 * The legacy workspace projection (`GET /public/projection`) predates this
 * namespace and keeps its EXACT behaviour: authenticated-origin CORS (a foreign
 * browser origin is still refused), the `crud` rate class, and its own entry in
 * the hub auth skip list. It is deliberately OUTSIDE the public door contract,
 * so it does not silently become cross-origin readable. Relative to a mount.
 */
export const PUBLIC_PROJECTION_PATH = "/public/projection";

/** Anything that could make the prefix test disagree with the router. */
const AMBIGUOUS = /(?:^|\/)\.{1,2}(?:\/|$)|\/\/|\\|%2e|%2f|%5c|%00/i;

/**
 * The hub-relative part of `path` (`/public/shares/x`), or null when `path` is
 * not under a hub mount. Query and fragment are ignored.
 */
function hubRelative(path: string): string | null {
  const p = path.split(/[?#]/, 1)[0] ?? "";
  for (const mount of PUBLIC_DOOR_MOUNTS) {
    if (p.startsWith(mount + "/")) return p.slice(mount.length);
  }
  return null;
}

/**
 * True when `path` (a FULL request path, e.g. `c.req.path`) is a credentialless
 * public door. The legacy projection is excluded (see
 * {@link PUBLIC_PROJECTION_PATH}); the bare prefix with nothing after it is not
 * a door.
 */
export function isPublicDoorPath(path: string): boolean {
  if (typeof path !== "string" || AMBIGUOUS.test(path)) return false;
  const rel = hubRelative(path);
  if (rel === null || !rel.startsWith(PUBLIC_DOOR_PREFIX)) return false;
  if (rel.length <= PUBLIC_DOOR_PREFIX.length) return false;
  if (
    rel === PUBLIC_PROJECTION_PATH ||
    rel.startsWith(PUBLIC_PROJECTION_PATH + "/")
  ) {
    return false;
  }
  return true;
}

/**
 * The capability segment of a public door path — `/public/<resource>/<token>…`
 * → `<token>` — used ONLY to key the per-share submit bucket (hashed there,
 * never logged). Null when the path is not a public door or has no token.
 */
export function publicDoorTokenSegment(path: string): string | null {
  if (!isPublicDoorPath(path)) return null;
  const rel = hubRelative(path)!;
  const parts = rel.slice(PUBLIC_DOOR_PREFIX.length).split("/");
  const token = parts[1];
  return token ? token : null;
}
