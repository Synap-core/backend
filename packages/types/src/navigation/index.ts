/**
 * The `view` readings an object-nav address may carry (`?view=room`,
 * `{ kind, id, view: 'room' }`) — a session's `'room'` view opens its Intake
 * Room instead of the plain session detail.
 *
 * THE one allowlist. The pod (signal targets, the handoff notification input),
 * the browser route table (`object-nav.ts`) and relay (`lib/object-nav.ts`) all
 * read it from here, so a new view is added once and every door that validates
 * an untrusted `view` agrees. Pure and dependency-free: safe to value-import in
 * Hermes via this subpath (never the package root barrel).
 */
export const OBJECT_NAV_VIEWS = ["room"] as const;

export type ObjectNavView = (typeof OBJECT_NAV_VIEWS)[number];

/** True iff `value` is a known view. Unknown/absent values (a stale link, an
 *  unrelated query param, a notification payload) must be DROPPED by the
 *  caller, never forwarded raw. */
export function isObjectNavView(value: unknown): value is ObjectNavView {
  return (
    typeof value === "string" &&
    (OBJECT_NAV_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * THE link rule for a URL a person is about to OPEN — a slot's `ref.url`, an
 * `act` ask's `url`, any agent-authored link a surface renders as a door.
 *
 * True iff `value` parses as an `http:` or `https:` URL. Script-capable and
 * non-network schemes (`javascript:`, `data:`, `file:`, custom app schemes) are
 * refused. Loopback / private hosts are deliberately ALLOWED: the pod never
 * fetches these (display / click-through only), and a developer must be able
 * to point at `http://localhost:3000/thing`.
 *
 * ONE definition: the pod's wire schemas (`@synap/shared-utils` re-exports this
 * as its `isHttpUrl`), relay and the browser all read it from here, so a link
 * the pod stored is exactly a link every surface will open — no surface opens
 * "any scheme" and none narrows to https-only. Never use it to guard a
 * server-side `fetch()` — that is `validateExternalUrl` / `safeExternalFetch`.
 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}
