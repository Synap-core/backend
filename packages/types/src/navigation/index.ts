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
