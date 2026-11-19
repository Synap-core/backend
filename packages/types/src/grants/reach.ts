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
 *    that is not a pod-wide read): wherever the person can reach;
 *  - `{kind: "projects", ids}` — no space, pinned to the named projects
 *    (`projectIds`, app permissions W2, decision 51ad8d1e F1/F3): it reaches
 *    the rows filed in one of them, and no whole space. A scope pinned to both
 *    spaces and projects stays a `spaces` place (its projects narrow inside
 *    them, as `permits` reads both limits).
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
  | { readonly kind: "spaces"; readonly ids: readonly [string, ...string[]] }
  | {
      readonly kind: "projects";
      readonly ids: readonly [string, ...string[]];
    };

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

/** The named projects, deduplicated in order; refuses an empty list or a blank id. */
export function projectsPlace(ids: readonly string[]): Place {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "")
      throw new PlaceError(
        "A project id is blank: a place names real projects."
      );
    if (!out.includes(id)) out.push(id);
  }
  const [first, ...rest] = out;
  if (first === undefined)
    throw new PlaceError(
      "An empty project list is not a place: a scope names its projects, or none (null)."
    );
  return { kind: "projects", ids: [first, ...rest] };
}

/**
 * THE parse of a grant scope's reach. A scope with spaces is those spaces. A
 * scope with no space but named projects is those projects, whoever holds
 * it. Otherwise `holder` decides what a scope with no space means: for an
 * app, a pod-wide read when it is one (`isPodWideReadScope`), else
 * unbounded; for a key or an AI, unbounded.
 */
export function parsePlace(scope: PlaceScopeLike, holder: PlaceHolder): Place {
  const ids = scope.workspaceIds;
  if (ids !== null && ids !== undefined) return spacesPlace(ids);
  // An empty project list pins nothing here, as before projects were a place
  // (`isPodWideReadScope` reads it the same way); only a named one is a place.
  const projects = scope.projectIds;
  if (projects !== null && projects !== undefined && projects.length > 0)
    return projectsPlace(projects);
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

/** The projects a place names; none for any other place. */
export function placeProjectIds(place: Place): readonly string[] {
  return place.kind === "projects" ? place.ids : [];
}

/**
 * Where a scope reaches for anything BEYOND reading named kinds — the question
 * the write, template, role and routing doors ask ("may it add an AI to this
 * space?"). A scope with no space that only reads named kinds
 * (`isPodWideReadScope`) reaches no space for that, whoever holds it: null.
 * Otherwise its place as a key's (`parsePlace`): its spaces, its projects
 * (which cover no whole space), or anywhere.
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

/**
 * Where a scope's ROWS sit, by space, beyond its pod-wide reads: the question
 * of a door that bounds what it shows or routes by space (the role rows a key
 * finds, the spaces a capture may land in). It does NOT say the scope covers
 * those spaces whole: a project or object pin beside them still narrows the
 * rows inside them (`permits`, the read clause).
 *
 *  - `"anywhere"`: a scope with no space, project or object pin;
 *  - the named spaces of a `spaces` place, pinned inside them or not;
 *  - none (`[]`) for a scope pinned to projects or objects with no space: no
 *    space is named, and there is no project-to-space mapping here (a
 *    project's spaces count only for a project-only session,
 *    `session-counted-spaces.ts`; "only project X" is no space, decision
 *    51ad8d1e F3). An empty project list, which `permits` reads as no project
 *    at all, names none either; nor does a scope that permits nothing
 *    (`{permissions: []}`, the deny-all `narrowKeyGrant` leaves);
 *  - null: a pod-wide read, which reaches no space beyond reading its kinds.
 */
export function spacesOfScopeRows(
  scope: PlaceScopeLike
): "anywhere" | readonly string[] | null {
  if (scope.permissions.length === 0) return [];
  const place = placeBeyondPodWideReads(scope);
  if (place === null) return null;
  switch (place.kind) {
    case "spaces":
      return place.ids;
    case "projects":
      return [];
    case "unbounded":
      return scope.projectIds != null || scope.entityIds != null
        ? []
        : "anywhere";
    default:
      return assertNeverPlace(place);
  }
}

/**
 * The spaces a scope covers WHOLE, beyond its pod-wide reads: the question of
 * a door that hands out a space itself (a membership: join it, add an AI to
 * it as an editor). Only a scope with no project or object pin covers a
 * space whole, the rule `grantCoversSpace` (`ensure-template.ts`) and
 * `namedPermissionPermits` (`grant-write-check.ts`) already apply:
 *
 *  - `"anywhere"`: a scope with no space, project or object pin;
 *  - the named spaces of a scope pinned to spaces only;
 *  - none (`[]`) for any scope pinned to projects or objects, beside spaces
 *    or not (its rows sit inside spaces, it covers none whole), an empty
 *    project list, and a scope that permits nothing;
 *  - null: a pod-wide read.
 */
export function spacesCoveredWhole(
  scope: PlaceScopeLike
): "anywhere" | readonly string[] | null {
  const rows = spacesOfScopeRows(scope);
  if (rows === null) return null;
  return scope.projectIds != null || scope.entityIds != null ? [] : rows;
}

/** One request as a connect proposal, `approved_requests` or `synap_grant` carry it. */
export interface PlaceRequestLike {
  readonly permission: string;
  readonly workspaceId: string | null;
  /**
   * The project a request is pinned to, with no space (additive, app
   * permissions W2). Absent or null on every pair an app holds today.
   */
  readonly projectId?: string | null;
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
  const projectId = request.projectId ?? null;
  if (projectId !== null) {
    if (workspaceId !== null || scope != null)
      throw new PlaceError(
        "A project request names its project only: no space and no scope."
      );
    return projectsPlace([projectId]);
  }
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
    case "projects":
      // A project pair carries its `projectId`, not a `scope` (W2).
      return null;
    default:
      return assertNeverPlace(place);
  }
}

/**
 * An app's request with its explicit place on the wire (`scope` beside
 * `workspaceId`, additive since access model B): what `approved_requests`, a
 * token's `synap_grant` and an `app/connect` proposal's `requests` carry. A
 * request with no place an app may hold (a write with no space) is refused,
 * and so is a project pair: an app's projects live in its v2 access
 * (`AppAccess`, `./app-access.ts`), never in its pairs.
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

/** A stable key for grouping by place ("pod", "unbounded", "spaces:a,b", "projects:p"). */
export function placeKey(place: Place): string {
  switch (place.kind) {
    case "pod":
    case "unbounded":
      return place.kind;
    case "spaces":
    case "projects":
      return `${place.kind}:${[...place.ids].sort().join(",")}`;
    default:
      return assertNeverPlace(place);
  }
}

/**
 * How wide a place kind reaches: named spaces, or named projects, ⊂ the pod ⊆
 * anywhere you can reach. Spaces and projects are the same width and neither
 * covers the other: a project's rows can sit in any space, and a space holds
 * rows of no chosen project (decision 51ad8d1e F3, a union).
 */
const WIDTH: Readonly<Record<Place["kind"], number>> = {
  spaces: 0,
  projects: 0,
  pod: 1,
  unbounded: 2,
};

/** Named places (spaces or projects) of the same kind: their id lists. */
function sameNamedKind(
  a: Place,
  b: Place
): [readonly string[], readonly string[]] | null {
  if (a.kind === "spaces" && b.kind === "spaces") return [a.ids, b.ids];
  if (a.kind === "projects" && b.kind === "projects") return [a.ids, b.ids];
  return null;
}

/** Does `outer` reach every row `inner` reaches? */
export function placeCovers(outer: Place, inner: Place): boolean {
  const named = sameNamedKind(outer, inner);
  if (named) return named[1].every((id) => named[0].includes(id));
  if (WIDTH[outer.kind] === 0 && WIDTH[inner.kind] === 0) return false;
  return WIDTH[outer.kind] >= WIDTH[inner.kind];
}

/**
 * The wider of two places; two space lists (or two project lists) join into
 * one. Spaces and projects have no single place that is their union: the
 * join is the pod, the narrowest place that holds both (a sentence that must
 * name both lists them, `accessModelOfParts`).
 */
export function joinPlaces(a: Place, b: Place): Place {
  if (a.kind === "spaces" && b.kind === "spaces")
    return spacesPlace([...a.ids, ...b.ids]);
  if (a.kind === "projects" && b.kind === "projects")
    return projectsPlace([...a.ids, ...b.ids]);
  if (WIDTH[a.kind] === 0 && WIDTH[b.kind] === 0) return POD_PLACE;
  return WIDTH[a.kind] >= WIDTH[b.kind] ? a : b;
}

/**
 * Where two narrowings both hold (an AI's ceiling and its key), or null when
 * nowhere. Anywhere narrows to the other; the pod narrows to named spaces or
 * projects. Spaces meet projects as the projects (the rows of those projects
 * inside those spaces: the project list is the narrower thing to name).
 */
export function meetPlaces(a: Place, b: Place): Place | null {
  if (a.kind === "spaces" && b.kind === "spaces") {
    const ids = a.ids.filter((id) => b.ids.includes(id));
    return ids.length > 0 ? spacesPlace(ids) : null;
  }
  if (a.kind === "projects" && b.kind === "projects") {
    const ids = a.ids.filter((id) => b.ids.includes(id));
    return ids.length > 0 ? projectsPlace(ids) : null;
  }
  if (a.kind === "projects" && b.kind === "spaces") return a;
  if (a.kind === "spaces" && b.kind === "projects") return b;
  return WIDTH[a.kind] <= WIDTH[b.kind] ? a : b;
}

/** A fifth place kind fails to compile where this is the `default`. */
export function assertNeverPlace(place: never): never {
  throw new PlaceError(`Unknown place: ${JSON.stringify(place)}`);
}
