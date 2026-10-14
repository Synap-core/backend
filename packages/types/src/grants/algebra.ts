/**
 * Grant algebra — cover, meet and containment of grants, EXACT with respect to
 * `permits` (the oracle in `grammar.ts`).
 *
 * Every permission pattern other than the lone `*` denotes a PRODUCT of three
 * sets over request keys:
 *
 *   subject   one word
 *   qualifier ANY (every kind, and an object whose kind is unknown) | one kind
 *             (only meaningful for QUALIFIED_GRANT_SUBJECTS)
 *   action    the four GRANT_ACTIONS | one named verb
 *
 * (`entity.note` = entity × {note} × GRANT_ACTIONS; `entity.*.read` =
 * entity × ANY × {read}; `proposal.approve` = proposal × {approve}.) Two
 * products intersect in a product, so the meet of two patterns is ONE pattern
 * or nothing — `entity.note ∧ entity.read = entity.note.read`. The earlier
 * rule kept a permission only when one side covered the other and dropped
 * every partial overlap, which clipped a key to nothing and revoked it.
 *
 * Pinnings (`workspaceIds` / `projectIds` / `entityIds`): `null`, `undefined`
 * and `[]` all mean UNPINNED here — the same reading as the one grant write
 * door (`GrantRepository` stores `[]` as null), so no stored grant ever
 * carries `[]`. `permits` itself would read a raw `[]` as "no place at all";
 * that spelling cannot reach it from the store, and the property tests
 * compare against `permits` on the normalised scope.
 *
 * KNOWN LIMIT (measured in algebra.test.ts): `permits` reads `projectIds` as
 * "the object is in ANY of these projects". Two such predicates do not meet
 * in one project set, so `meetScope` intersects the project sets — sound
 * (never wider than either side) and complete for every object filed in at
 * most one project; an object filed in two projects, one per side, falls
 * outside the meet (fail closed).
 *
 * Pure — no I/O.
 */
import {
  GRANT_ACTIONS,
  QUALIFIED_GRANT_SUBJECTS,
  parsePermission,
  type GrantScope,
} from "./grammar.js";

const ANY = "*";

/** A non-`*` pattern as its product; `qualifier`/`action` null = ANY / GRANT_ACTIONS. */
interface Product {
  subject: string;
  qualified: boolean;
  qualifier: string | null;
  action: string | null;
}

function isQualified(subject: string): boolean {
  return (QUALIFIED_GRANT_SUBJECTS as readonly string[]).includes(subject);
}

function isGrantAction(action: string): boolean {
  return (GRANT_ACTIONS as readonly string[]).includes(action);
}

/** null for the lone `*` (the universe, gate verbs included). */
function toProduct(pattern: string): Product | null {
  const segs = parsePermission(pattern);
  if (segs[0] === ANY) return null;
  const subject = segs[0]!;
  const qualified = isQualified(subject);
  const q = qualified ? segs[1] : undefined;
  const a = qualified ? segs[2] : segs[1];
  return {
    subject,
    qualified,
    qualifier: q === undefined || q === ANY ? null : q,
    action: a === undefined || a === ANY ? null : a,
  };
}

/** A ⊆ B for one dimension, where null = the whole dimension. */
function qualifierWithin(inner: string | null, outer: string | null): boolean {
  return outer === null || inner === outer;
}

function actionWithin(inner: string | null, outer: string | null): boolean {
  if (outer === null) return inner === null || isGrantAction(inner);
  return inner === outer;
}

function productWithin(inner: Product, outer: Product): boolean {
  return (
    inner.subject === outer.subject &&
    (!inner.qualified || qualifierWithin(inner.qualifier, outer.qualifier)) &&
    actionWithin(inner.action, outer.action)
  );
}

/** Does `outer` permit every request `inner` permits? */
export function covers(outer: string, inner: string): boolean {
  const o = toProduct(outer);
  if (o === null) return true;
  const i = toProduct(inner);
  if (i === null) return false;
  return productWithin(i, o);
}

/**
 * The greatest pattern both permit: `permits([m], r) ⇔ permits([a], r) ∧
 * permits([b], r)` for every request r. null = they share no request. When
 * one side covers the other, that side is returned verbatim.
 */
export function meetPermission(a: string, b: string): string | null {
  if (covers(b, a)) return a;
  if (covers(a, b)) return b;
  const pa = toProduct(a)!;
  const pb = toProduct(b)!;
  if (pa.subject !== pb.subject) return null;
  let qualifier: string | null = null;
  if (pa.qualified) {
    if (pa.qualifier !== null && pb.qualifier !== null) return null; // two different kinds
    qualifier = pa.qualifier ?? pb.qualifier;
  }
  let action: string | null;
  if (pa.action === null) action = isGrantAction(pb.action!) ? pb.action : null;
  else if (pb.action === null)
    action = isGrantAction(pa.action) ? pa.action : null;
  else action = null; // two different named verbs
  if (action === null) return null;
  // A partial overlap narrows each side on a different dimension, so it is
  // always a qualified kind × one verb. Always the three-segment spelling:
  // `entity.<kind>` would re-parse as a verb when the kind spells one.
  return pa.qualified
    ? `${pa.subject}.${qualifier ?? ANY}.${action}`
    : `${pa.subject}.${action}`;
}

/** Drop a pattern another one in the list already covers (keeps the first of equals). */
function minimal(patterns: readonly string[]): string[] {
  const out: string[] = [];
  patterns.forEach((p, i) => {
    const shadowed = patterns.some(
      (q, j) => j !== i && covers(q, p) && (!covers(p, q) || j < i)
    );
    if (!shadowed) out.push(p);
  });
  return out;
}

/** The meet of two permission lists (each read as the union of its patterns). */
export function meetPermissions(
  a: readonly string[],
  b: readonly string[]
): string[] {
  const out: string[] = [];
  for (const p of a)
    for (const q of b) {
      const m = meetPermission(p, q);
      if (m !== null && !out.includes(m)) out.push(m);
    }
  return minimal(out);
}

/**
 * Does the union of `outer` permit every request `inner` permits? Exact: a
 * pattern split across several (`entity.note` ⊆ its four verbs listed one by
 * one) is within. The kind set is open, so ANY kind is only ever within a
 * pattern that is ANY kind itself.
 */
export function permissionWithin(
  inner: string,
  outer: readonly string[]
): boolean {
  if (outer.some((o) => covers(o, inner))) return true;
  const i = toProduct(inner);
  if (i === null || i.action !== null) return false;
  return GRANT_ACTIONS.every((action) =>
    outer.some((o) => {
      const p = toProduct(o);
      return p === null || productWithin({ ...i, action }, p);
    })
  );
}

/** A pinning as the store reads it: null/undefined/[] = unpinned (null). */
export function normalizePinning(
  ids: readonly string[] | null | undefined
): string[] | null {
  return ids && ids.length > 0 ? [...new Set(ids)] : null;
}

/** Both pinnings at once (null = unpinned); `undefined` = they share no place. */
export function meetPinning(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined
): string[] | null | undefined {
  const na = normalizePinning(a);
  const nb = normalizePinning(b);
  if (na === null) return nb;
  if (nb === null) return na;
  const shared = na.filter((x) => nb.includes(x));
  return shared.length > 0 ? shared : undefined;
}

/** Is every place `inner` allows also allowed by `outer`? */
export function pinningWithin(
  inner: readonly string[] | null | undefined,
  outer: readonly string[] | null | undefined
): boolean {
  const no = normalizePinning(outer);
  if (no === null) return true;
  const ni = normalizePinning(inner);
  return ni !== null && ni.every((x) => no.includes(x));
}

export type ScopeBounds = Pick<
  GrantScope,
  "permissions" | "workspaceIds" | "projectIds" | "entityIds"
>;

export interface MetScope {
  permissions: string[];
  workspaceIds: string[] | null;
  projectIds: string[] | null;
  entityIds: string[] | null;
}

/**
 * What both scopes permit, as one scope (pinnings normalised: null =
 * unpinned). null = no overlap. See the project-pinning limit above.
 */
export function meetScope(a: ScopeBounds, b: ScopeBounds): MetScope | null {
  const workspaceIds = meetPinning(a.workspaceIds, b.workspaceIds);
  const projectIds = meetPinning(a.projectIds, b.projectIds);
  const entityIds = meetPinning(a.entityIds, b.entityIds);
  if (
    workspaceIds === undefined ||
    projectIds === undefined ||
    entityIds === undefined
  )
    return null;
  const permissions = meetPermissions(a.permissions, b.permissions);
  if (permissions.length === 0) return null;
  return { permissions, workspaceIds, projectIds, entityIds };
}

/**
 * `inner ⊆ outer`: every request `inner` permits, `outer` permits too.
 * A scope with no permission permits nothing and is within anything.
 */
export function scopeWithin(inner: ScopeBounds, outer: ScopeBounds): boolean {
  if (inner.permissions.length === 0) return true;
  return (
    inner.permissions.every((p) => permissionWithin(p, outer.permissions)) &&
    pinningWithin(inner.workspaceIds, outer.workspaceIds) &&
    pinningWithin(inner.projectIds, outer.projectIds) &&
    pinningWithin(inner.entityIds, outer.entityIds)
  );
}
