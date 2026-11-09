/**
 * Where a grant reaches — ONE explicit place, parsed ONCE (access model B,
 * founder decision of 2 Nov 2026, plan 2c8fca91 §1).
 *
 * Storage keeps a nullable space list (`grants.workspace_ids`, the
 * `{permission, workspaceId}` pairs of `approved_requests` and of a connect
 * proposal). A missing list meant different things to different readers: for
 * a key or an AI it is "no narrowing" (anywhere the person can reach); for an
 * app it is a pod-wide READ of named kinds (decision e1b59d38 "B"); and an
 * empty list `[]` was read four ways. Every reader now asks `parsePlace` (or
 * `parseRequestPlace`) and switches on the result, exhaustively:
 *
 *  - `{kind: "spaces", ids}` — the named spaces, never empty;
 *  - `{kind: "pod"}` — an app's pod-wide read (`isPodWideReadScope`): it reads
 *    its kinds everywhere in the pod, and nothing else;
 *  - `{kind: "unbounded"}` — no space narrowing (a key, an AI, or an app part
 *    that is not a pod-wide read): wherever the person can reach.
 *
 * `[]` is not a place: it is refused (`PlaceError`), never a fourth meaning.
 * The events lens's "personal" (events with no space, `event-visibility.ts`)
 * is a different question and never a Place.
 *
 * Pure: no I/O.
 */

import { isPodWideReadPermission, isPodWideReadScope } from "./pod-wide.js";

/** Who holds the grant: the one input that decides what "no space" means. */
export type PlaceHolder = "app" | "key" | "agent";

/** Where a grant (or one request) reaches. */
export type Place =
  | { readonly kind: "pod" }
  | { readonly kind: "unbounded" }
  | { readonly kind: "spaces"; readonly ids: readonly [string, ...string[]] };

export const POD_PLACE: Place = Object.freeze({ kind: "pod" });
export const UNBOUNDED_PLACE: Place = Object.freeze({ kind: "unbounded" });

/** A stored or sent reach that is no place: an empty list, a blank id, a contradiction. */
export class PlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceError";
  }
}

/** The scope fields the parse reads; any grant scope or draft satisfies it. */
export interface PlaceScopeLike {
  readonly permissions: readonly string[];
  readonly workspaceIds?: readonly string[] | null;
  readonly projectIds?: readonly string[] | null;
  readonly entityIds?: readonly string[] | null;
}

/** The named spaces, deduplicated in order; refuses an empty list or a blank id. */
export function spacesPlace(ids: readonly string[]): Place {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "")
      throw new PlaceError("A space id is blank: a place names real spaces.");
    if (!out.includes(id)) out.push(id);
  }
  const [first, ...rest] = out;
  if (first === undefined)
    throw new PlaceError(
      "An empty space list is not a place: a scope names its spaces, or none (null)."
    );
  return { kind: "spaces", ids: [first, ...rest] };
}

/**
 * THE parse of a grant scope's reach. `holder` decides what a scope with no
 * space means: for an app, a pod-wide read when it is one
 * (`isPodWideReadScope`), else unbounded; for a key or an AI, unbounded.
 */
export function parsePlace(scope: PlaceScopeLike, holder: PlaceHolder): Place {
  const ids = scope.workspaceIds;
  if (ids !== null && ids !== undefined) return spacesPlace(ids);
  return holder === "app" && isPodWideReadScope(scope)
    ? POD_PLACE
    : UNBOUNDED_PLACE;
}

/**
 * Who holds a stored grant: one minted for an OAuth client (`client_id`: an
 * app's key, a person's app sign-in) is an app's; any other is a key's — a
 * person's or an AI's, which read "no space" alike (unbounded).
 */
export function holderOfGrant(grant: {
  readonly clientId?: string | null;
}): PlaceHolder {
  return grant.clientId ? "app" : "key";
}

/** The spaces a place names; none for the pod or anywhere. */
export function placeSpaceIds(place: Place): readonly string[] {
  return place.kind === "spaces" ? place.ids : [];
}

/**
 * Where a scope reaches for anything BEYOND reading named kinds — the question
 * the write, template, role and routing doors ask ("may it add an AI to this
 * space?"). A scope with no space that only reads named kinds
 * (`isPodWideReadScope`) reaches no space for that, whoever holds it: null.
 * Otherwise its place as a key's (`parsePlace`): its spaces, or anywhere.
 */
export function placeBeyondPodWideReads(
  scope: PlaceScopeLike
): SpacesOrAnywhere | null {
  if (scope.workspaceIds == null && isPodWideReadScope(scope)) return null;
  const place = parsePlace(scope, "key");
  return place.kind === "pod" ? null : place;
}

/** A place that is not the pod: what a scope reaches beyond its pod-wide reads. */
export type SpacesOrAnywhere = Exclude<Place, { readonly kind: "pod" }>;

/** One request as a connect proposal, `approved_requests` or `synap_grant` carry it. */
export interface PlaceRequestLike {
  readonly permission: string;
  readonly workspaceId: string | null;
  /**
   * The explicit place an app's request carries beside `workspaceId: null`
   * (additive wire field since access model B). Absent on older rows and on
   * an AI's requests: the parse then derives it.
   */
  readonly scope?: "space" | "pod" | null;
}

/**
 * THE parse of one request's reach. An explicit `scope` must agree with the
 * space it names ("pod" with no space, and a pod-wide read; "space" with a
 * space); without it, the request reads as a one-permission scope.
 */
export function parseRequestPlace(
  request: PlaceRequestLike,
  holder: PlaceHolder
): Place {
  const { workspaceId, scope, permission } = request;
  if (scope === "pod") {
    if (workspaceId !== null)
      throw new PlaceError("A pod-wide request names no space.");
    if (!isPodWideReadPermission(permission))
      throw new PlaceError(
        `Only a read (of a kind, or of a subject on the pod-wide list) is pod-wide, not ${permission}.`
      );
    return POD_PLACE;
  }
  if (scope === "space" && workspaceId === null)
    throw new PlaceError("A space request names its space.");
  return parsePlace(
    {
      permissions: [permission],
      workspaceIds: workspaceId === null ? null : [workspaceId],
    },
    holder
  );
}

/**
 * The wire's explicit place for an app's request (`scope` beside
 * `workspaceId`): "space" or "pod". An unbounded request has none (an app
 * never holds one; an AI's request carries no `scope`).
 */
export function requestScopeOf(place: Place): "space" | "pod" | null {
  switch (place.kind) {
    case "spaces":
      return "space";
    case "pod":
      return "pod";
    case "unbounded":
      return null;
    default:
      return assertNeverPlace(place);
  }
}

/**
 * An app's request with its explicit place on the wire (`scope` beside
 * `workspaceId`, additive since access model B): what `approved_requests`, a
 * token's `synap_grant` and an `app/connect` proposal's `requests` carry. A
 * request with no place an app may hold (a write with no space) is refused.
 */
export function withAppRequestScope<T extends PlaceRequestLike>(
  request: T
): T & { scope: "space" | "pod" } {
  const scope = requestScopeOf(parseRequestPlace(request, "app"));
  if (scope === null)
    throw new PlaceError(
      `An app holds ${request.permission} only in a space, or as a pod-wide read.`
    );
  return { ...request, scope };
}

/** A stable key for grouping by place ("pod", "unbounded", "spaces:a,b"). */
export function placeKey(place: Place): string {
  switch (place.kind) {
    case "pod":
    case "unbounded":
      return place.kind;
    case "spaces":
      return `spaces:${[...place.ids].sort().join(",")}`;
    default:
      return assertNeverPlace(place);
  }
}

/** How wide a place kind reaches: spaces ⊂ the pod ⊆ anywhere you can reach. */
const WIDTH: Readonly<Record<Place["kind"], number>> = {
  spaces: 0,
  pod: 1,
  unbounded: 2,
};

/** Does `outer` reach every space `inner` reaches? */
export function placeCovers(outer: Place, inner: Place): boolean {
  if (outer.kind === "spaces" && inner.kind === "spaces")
    return inner.ids.every((id) => outer.ids.includes(id));
  return WIDTH[outer.kind] >= WIDTH[inner.kind];
}

/** The wider of two places; two space lists join into one. */
export function joinPlaces(a: Place, b: Place): Place {
  if (a.kind === "spaces" && b.kind === "spaces")
    return spacesPlace([...a.ids, ...b.ids]);
  return WIDTH[a.kind] >= WIDTH[b.kind] ? a : b;
}

/**
 * Where two narrowings both hold (an AI's ceiling and its key), or null when
 * nowhere. Anywhere narrows to the other; the pod narrows to named spaces.
 */
export function meetPlaces(a: Place, b: Place): Place | null {
  if (a.kind === "spaces" && b.kind === "spaces") {
    const ids = a.ids.filter((id) => b.ids.includes(id));
    return ids.length > 0 ? spacesPlace(ids) : null;
  }
  return WIDTH[a.kind] <= WIDTH[b.kind] ? a : b;
}

/** A fourth place kind fails to compile where this is the `default`. */
export function assertNeverPlace(place: never): never {
  throw new PlaceError(`Unknown place: ${JSON.stringify(place)}`);
}
