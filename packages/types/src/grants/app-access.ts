/**
 * An app connection's access, v2 (app permissions W2, founder decision
 * 51ad8d1e, 19 Nov 2026; plan 8189ae7c §3 Option A).
 *
 * A connection holds WHAT it may do (its permissions) and WHERE, once for
 * the whole connection, per tier:
 *
 *   { version: 2,
 *     permissions: string[],
 *     read:  { spaces: "all" | id[], projects: "all" | id[] },
 *     write: { spaces: id[],          projects: id[] } }
 *
 *  - A permission whose action is `read` holds where `read` says; every
 *    other permission (a write, a gate verb, `*`) holds where `write` says.
 *  - Spaces and projects are a UNION (F3): a row is in reach when it is in a
 *    chosen space OR filed in a chosen project.
 *  - Reads with All spaces are live and include future spaces (F2): today's
 *    pod-wide read (`isPodWideReadPermission`, decision e1b59d38 "B").
 *    Writes are Select only: `write` never says "all".
 *
 * Until W3 writes it from the consent screen, a v2 access is only ever the
 * LIFT of an app's `approved_requests` pairs (`liftApprovedRequests`), and a
 * lift is LOSSLESS: it is refused (re-consent) unless the grants of the v2
 * form give the app exactly the reach the old rows give, no more and no
 * less: the same permits (the engine's `permits`, over the finite probes
 * that decide it) and the same placement (each space as viewer or editor,
 * and the pod). Compared by meaning, not by key (W3c): `entity.note.read`
 * in A beside `entity.read` in A adds nothing. So reading v2 or the pairs
 * gives the same reach (`grantScopesForAccess` against the pairs' grants,
 * app-access.test.ts).
 *
 * Pure: no I/O.
 */

import { isPodWideReadPermission } from "./pod-wide.js";
import { permissionWithin } from "./algebra.js";
import {
  GRANT_ACTIONS,
  InvalidPermissionError,
  parsePermission,
  patternMatches,
  permits,
  QUALIFIED_GRANT_SUBJECTS,
  type GrantRequest,
} from "./grammar.js";
import {
  assertNeverPlace,
  parsePlace,
  parseRequestPlace,
  PlaceError,
  placeProjectIds,
  placeSpaceIds,
  type PlaceRequestLike,
} from "./reach.js";

export const APP_ACCESS_VERSION = 2 as const;

/** Where a tier of reads holds: every space (live) or the named ones. */
export type AccessAllOrIds = "all" | readonly string[];

/** An app connection's access, v2. */
export interface AppAccess {
  readonly version: typeof APP_ACCESS_VERSION;
  /** What it may do, each once, in the order first given. */
  readonly permissions: readonly string[];
  /** Where its reads hold. "all" spaces = every space, now and future (F2). */
  readonly read: {
    readonly spaces: AccessAllOrIds;
    readonly projects: AccessAllOrIds;
  };
  /** Where everything else holds: Select only, never "all" (F2). */
  readonly write: {
    readonly spaces: readonly string[];
    readonly projects: readonly string[];
  };
}

/** The empty access: nothing, nowhere. */
export const NO_APP_ACCESS: AppAccess = Object.freeze({
  version: APP_ACCESS_VERSION,
  permissions: Object.freeze([]) as readonly string[],
  read: Object.freeze({
    spaces: Object.freeze([]) as readonly string[],
    projects: Object.freeze([]) as readonly string[],
  }),
  write: Object.freeze({
    spaces: Object.freeze([]) as readonly string[],
    projects: Object.freeze([]) as readonly string[],
  }),
});

/**
 * Is this permission a READ (its action segment is `read`)? A read holds
 * where `read` says; anything else (`create`, `update`, `delete`, a gate
 * verb, a whole kind, `*`) is a write and holds where `write` says.
 */
export function isReadPermission(permission: string): boolean {
  return permission.trim().split(".").at(-1) === "read";
}

// ── one (permission, place) pair ─────────────────────────────────────────

/**
 * One place a pair holds in, the unit both forms are compared in: a space,
 * the pod (a read in every space, live), a project, or every project.
 */
export type AccessWhere =
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "pod" }
  | { readonly kind: "project"; readonly id: string }
  | { readonly kind: "all-projects" };

/** One permission in one place. */
export interface AccessPair {
  readonly permission: string;
  readonly where: AccessWhere;
}

/** The pair's place as a stable key ("space:<id>", "pod", "project:<id>", "all-projects"). */
export function accessWhereKey(where: AccessWhere): string {
  switch (where.kind) {
    case "space":
    case "project":
      return `${where.kind}:${where.id}`;
    case "pod":
    case "all-projects":
      return where.kind;
    default:
      return unreachableWhere(where);
  }
}

/** A pair as a stable key. */
export function accessPairKey(pair: AccessPair): string {
  return `${accessWhereKey(pair.where)}\u0000${pair.permission}`;
}

function unreachableWhere(where: never): never {
  throw new Error(`Unknown access place: ${JSON.stringify(where)}`);
}

/** Every (permission, place) pair a v2 access allows, each once. */
export function expandAppAccess(access: AppAccess): AccessPair[] {
  const out = new Map<string, AccessPair>();
  const add = (permission: string, where: AccessWhere) => {
    const pair = { permission, where };
    out.set(accessPairKey(pair), pair);
  };
  for (const permission of access.permissions) {
    const tier = isReadPermission(permission) ? access.read : access.write;
    const spaces: AccessAllOrIds = tier.spaces;
    const projects: AccessAllOrIds = tier.projects;
    if (spaces === "all") add(permission, { kind: "pod" });
    else for (const id of spaces) add(permission, { kind: "space", id });
    if (projects === "all") add(permission, { kind: "all-projects" });
    else for (const id of projects) add(permission, { kind: "project", id });
  }
  return [...out.values()];
}

/** The pairs of `approved_requests`, read as an app's (`parseRequestPlace`). */
export interface RequestPairs {
  /** Each placeable pair, once. */
  readonly pairs: readonly AccessPair[];
  /** The rows no app may hold (a write with no space, a blank id…): no grant. */
  readonly unplaceable: readonly PlaceRequestLike[];
}

/** Read stored or sent pairs into (permission, place) pairs, each once. */
export function pairsOfRequests(
  requests: readonly PlaceRequestLike[]
): RequestPairs {
  const pairs = new Map<string, AccessPair>();
  const unplaceable: PlaceRequestLike[] = [];
  for (const r of requests) {
    let wheres: AccessWhere[];
    try {
      const place = parseRequestPlace(r, "app");
      switch (place.kind) {
        case "spaces":
          wheres = place.ids.map((id) => ({ kind: "space" as const, id }));
          break;
        case "pod":
          wheres = [{ kind: "pod" }];
          break;
        case "projects":
          wheres = place.ids.map((id) => ({ kind: "project" as const, id }));
          break;
        case "unbounded":
          wheres = [];
          break;
        default:
          throw new PlaceError(`Unknown place: ${JSON.stringify(place)}`);
      }
    } catch (err) {
      if (!(err instanceof PlaceError)) throw err;
      wheres = [];
    }
    if (wheres.length === 0) {
      unplaceable.push(r);
      continue;
    }
    for (const where of wheres) {
      const pair = { permission: r.permission, where };
      pairs.set(accessPairKey(pair), pair);
    }
  }
  return { pairs: [...pairs.values()], unplaceable };
}

// ── the lift: old pairs → v2, never wider, never narrower ─────────────────

/** Why a connection's pairs cannot become v2 as they are: it asks again. */
export type ReconsentReason =
  /** A row no app may hold (a write with no space): it grants nothing today. */
  | "unplaceable"
  /** The v2 form would allow a pair the rows never held. */
  | "widens"
  /** The v2 form would lose a pair the rows hold (a space read beside "all"). */
  | "narrows"
  /**
   * The rows are too large to compare within `LIFT_PROBE_BUDGET`: the lift
   * is not attempted (fail closed), and the connection keeps its pairs.
   */
  | "too-large";

export interface Reconsent {
  /**
   * The first reason found, in the order unplaceable, too-large, widens,
   * narrows.
   */
  readonly reason: ReconsentReason;
  /** What the v2 form would allow that the rows did not (at most 5). */
  readonly widens: readonly AccessPair[];
  /** What the rows hold that the v2 form would lose (at most 5). */
  readonly narrows: readonly AccessPair[];
  /** How many rows no app may hold. */
  readonly unplaceable: number;
}

export type LiftResult =
  { readonly access: AppAccess } | { readonly reconsent: Reconsent };

/**
 * The v2 form a connection's pairs suggest, before it is checked: the same
 * permissions; reads in the union of the spaces of its read pairs, or "all"
 * when any read is pod-wide; writes in the union of the spaces of its write
 * pairs; no projects (no pair names one). Each tier unions its own spaces,
 * so "read A in Sales, write B in Finance" stays exactly that.
 */
export function candidateAccess(pairs: readonly AccessPair[]): AppAccess {
  const permissions: string[] = [];
  const readSpaces: string[] = [];
  const writeSpaces: string[] = [];
  const readProjects: string[] = [];
  const writeProjects: string[] = [];
  let readAll = false;
  let readAllProjects = false;
  const push = (list: string[], id: string) => {
    if (!list.includes(id)) list.push(id);
  };
  for (const { permission, where } of pairs) {
    push(permissions, permission);
    const read = isReadPermission(permission);
    switch (where.kind) {
      case "space":
        push(read ? readSpaces : writeSpaces, where.id);
        break;
      case "project":
        push(read ? readProjects : writeProjects, where.id);
        break;
      case "pod":
        // A pod-wide pair is always a read (`isPodWideReadPermission`).
        readAll = true;
        break;
      case "all-projects":
        readAllProjects = true;
        break;
      default:
        unreachableWhere(where);
    }
  }
  return {
    version: APP_ACCESS_VERSION,
    permissions,
    read: {
      spaces: readAll ? "all" : readSpaces,
      projects: readAllProjects ? "all" : readProjects,
    },
    write: { spaces: writeSpaces, projects: writeProjects },
  };
}

const SAMPLE = 5;

/**
 * The grant scopes a connection's PAIRS make, read as what they mean: one
 * scope per space with the permissions approved there, one per project, and
 * one unpinned scope for the pod-wide reads. The same scopes as the pre-W2
 * per-space grants (`grantsForPairs`, app-connect), plus a project pair as
 * its project's scope (no pair names a project today).
 */
export function scopesOfPairs(
  pairs: readonly AccessPair[]
): AppAccessGrantScope[] {
  const bySpace = new Map<string, string[]>();
  const byProject = new Map<string, string[]>();
  const pod: string[] = [];
  const push = (map: Map<string, string[]>, id: string, p: string) => {
    const list = map.get(id) ?? [];
    if (!list.includes(p)) list.push(p);
    map.set(id, list);
  };
  for (const { permission, where } of pairs) {
    switch (where.kind) {
      case "space":
        push(bySpace, where.id, permission);
        break;
      case "project":
        push(byProject, where.id, permission);
        break;
      case "pod":
        if (!pod.includes(permission)) pod.push(permission);
        break;
      case "all-projects":
        // No pair says "every project", and no scope pins it (fail closed).
        break;
      default:
        unreachableWhere(where);
    }
  }
  return [
    ...[...bySpace].map(([id, permissions]) => ({
      permissions,
      workspaceIds: [id],
    })),
    ...[...byProject].map(([id, permissions]) => ({
      permissions,
      projectIds: [id],
    })),
    ...(pod.length > 0 ? [{ permissions: pod }] : []),
  ];
}

// ── the semantic comparison: what two sets of scopes PERMIT ──────────────

/** A token no permission names: it stands for every unnamed one. */
const OTHER = "<other>";
const OTHER_VERB = "<other-verb>";
const OTHER_SPACE = "<another space>";
const OTHER_PROJECT = "<another project>";

/** One place a request is asked in (a row's space and/or project). */
interface PlaceProbe {
  readonly workspaceId?: string;
  readonly projectId?: string;
}

/** The request half of a probe: what is asked, with no place. */
type PermissionProbe = Pick<GrantRequest, "subject" | "qualifier" | "action">;

/**
 * The finite set of requests that decides whether two sets of scopes permit
 * the same thing. A pattern only ever compares a segment with a token it
 * NAMES (or matches any with `*`), and a scope's limits only compare ids it
 * NAMES, so every request that swaps an unnamed token for another unnamed
 * one is answered the same by every scope. The probes are therefore: each
 * named subject (plus one unnamed), each named kind of a qualified subject
 * (plus one unnamed, plus "kind unknown"), each grant action, each named
 * verb (plus one unnamed gate verb); in each named space, no space (the pod),
 * each named project, and one unnamed space and project. Named first, so a
 * sample shows a real name before a stand-in.
 */
function probesFor(
  patterns: readonly string[],
  scopes: readonly AppAccessGrantScope[]
): {
  permissions: PermissionProbe[];
  places: PlaceProbe[];
} {
  const subjects: string[] = [];
  const kinds: string[] = [];
  const actions: string[] = [...GRANT_ACTIONS];
  const spaces: string[] = [];
  const projects: string[] = [];
  const add = (list: string[], v: string | undefined) => {
    if (v !== undefined && v !== "*" && !list.includes(v)) list.push(v);
  };
  const qualified = QUALIFIED_GRANT_SUBJECTS as readonly string[];
  // Each distinct pattern parsed once: [subject], [subject, action], or a
  // qualified [subject, kind] / [subject, kind, action] (`parsePermission`
  // spells an every-kind `entity.read` as [entity, *, read]).
  for (const raw of patterns) {
    const segs = parsePermission(raw);
    add(subjects, segs[0]);
    if (qualified.includes(segs[0]!)) {
      add(kinds, segs[1]);
      add(actions, segs[2]);
    } else add(actions, segs[1]);
  }
  // The places the scopes name, read through THE parse (`parsePlace`).
  for (const s of scopes) {
    const place = parsePlace(s, "app");
    for (const id of placeSpaceIds(place)) add(spaces, id);
    for (const id of placeProjectIds(place)) add(projects, id);
  }
  subjects.push(OTHER);
  actions.push(OTHER_VERB);
  const permissions: PermissionProbe[] = [];
  for (const subject of subjects)
    for (const action of actions) {
      if (!qualified.includes(subject)) {
        permissions.push({ subject, qualifier: null, action });
        continue;
      }
      for (const qualifier of [...kinds, OTHER, null])
        permissions.push({ subject, qualifier, action });
    }
  const places: PlaceProbe[] = [];
  for (const workspaceId of [...spaces, undefined, OTHER_SPACE])
    for (const projectId of [undefined, ...projects, OTHER_PROJECT])
      places.push({ workspaceId, projectId });
  return { permissions, places };
}

function whereOfProbe(place: PlaceProbe): AccessWhere {
  if (place.workspaceId !== undefined)
    return { kind: "space", id: place.workspaceId };
  if (place.projectId !== undefined)
    return { kind: "project", id: place.projectId };
  return { kind: "pod" };
}

/**
 * The most work one comparison may do, in pattern × probe evaluations
 * (`probes × (distinct patterns + pattern occurrences)`). Above it the lift
 * is not attempted and fails CLOSED: a re-consent with reason "too-large",
 * the connection kept on its pairs. Measured on the shapes of the pod's real
 * connections (app-access.test.ts): synap-chat as it asks today and Content
 * Studio's 46 asks in 3 spaces each cost a few tens of thousands, so 200 000
 * leaves several times their room; one F4 entry at its cap (64 kinds) in a
 * few spaces fits; 48 such entries (~3 000 kinds) do not, and re-consent.
 * Every lift runs synchronously on consent, sign-in and token mint, so the
 * bound is on the work, not on the rows.
 */
export const LIFT_PROBE_BUDGET = 200_000;

/** A comparison above `LIFT_PROBE_BUDGET`: not attempted. */
export class LiftTooLargeError extends Error {
  constructor(readonly cost: number) {
    super(
      `Comparing these grants would take ${cost} evaluations, above the budget of ${LIFT_PROBE_BUDGET}`
    );
    this.name = "LiftTooLargeError";
  }
}

function costOf(
  probes: number,
  distinct: number,
  scopes: readonly AppAccessGrantScope[]
): number {
  const occurrences = scopes.reduce((n, s) => n + s.permissions.length, 0);
  return probes * (distinct + occurrences);
}

/**
 * The work comparing two sets of scopes takes, in the unit of
 * `LIFT_PROBE_BUDGET`: probes × (distinct patterns + pattern occurrences).
 */
export function appScopesCompareCost(
  before: readonly AppAccessGrantScope[],
  after: readonly AppAccessGrantScope[]
): number {
  const all = [...before, ...after];
  const distinct = [...new Set(all.flatMap((s) => s.permissions))];
  return costOf(
    probesFor(distinct, all).permissions.length,
    distinct.length,
    all
  );
}

/** What a comparison needs: examples (at most `SAMPLE` each way), or only whether there is a difference. */
export interface CompareOptions {
  /**
   * false: stop at the first difference (a verdict is all the caller needs;
   * the samples then hold that one difference). Default true.
   */
  readonly examples?: boolean;
}

/**
 * What `after` permits that `before` does not (`gained`), and the reverse
 * (`lost`), asked through the engine's own `permits` over the probes of
 * both. Each difference is shown as the first pattern of the side that
 * permits it, at the probe's place (each pair once, at most `SAMPLE`).
 *
 * `permits(scope, request)` is "a pattern matches the request AND every
 * limit holds for its place": each DISTINCT pattern is asked once per probe
 * request (`patternMatches`), each scope's limits once per probe place
 * (`permits` with `*`), and the two are joined. Exact. Bounded by
 * `LIFT_PROBE_BUDGET` (throws `LiftTooLargeError` before any work), and with
 * `examples: false` it stops at the first difference.
 */
function permitDiffs(
  before: readonly AppAccessGrantScope[],
  after: readonly AppAccessGrantScope[],
  options: CompareOptions = {}
): { gained: AccessPair[]; lost: AccessPair[] } {
  const examples = options.examples !== false;
  const all = [...before, ...after];
  const distinct = [...new Set(all.flatMap((s) => s.permissions))];
  const { permissions, places } = probesFor(distinct, all);
  const cost = costOf(permissions.length, distinct.length, all);
  if (cost > LIFT_PROBE_BUDGET) throw new LiftTooLargeError(cost);

  // Each distinct pattern against each probe request, once.
  const matches = new Map<string, Uint8Array>();
  for (const p of distinct) {
    const row = new Uint8Array(permissions.length);
    for (let r = 0; r < permissions.length; r++)
      row[r] = patternMatches(p, permissions[r]!) ? 1 : 0;
    matches.set(p, row);
  }
  const side = (scopes: readonly AppAccessGrantScope[]) =>
    scopes.map((s) => {
      // Does ANY of the scope's patterns match probe r?
      const any = new Uint8Array(permissions.length);
      for (const p of s.permissions) {
        const row = matches.get(p)!;
        for (let r = 0; r < row.length; r++) if (row[r]) any[r] = 1;
      }
      // The scope's own limits, asked through `permits` (any request: `*`).
      const at = places.map((pl) =>
        permits(
          { ...s, permissions: ["*"] },
          {
            subject: OTHER,
            action: OTHER_VERB,
            workspaceId: pl.workspaceId ?? null,
            projectIds: pl.projectId === undefined ? null : [pl.projectId],
          }
        )
      );
      return { permissions: s.permissions, any, at };
    });
  const b = side(before);
  const a = side(after);
  const permitted = (scopes: typeof a, r: number, i: number) =>
    scopes.some((s) => s.any[r] === 1 && s.at[i]);
  /** The first pattern of `scopes` that permits probe `r` at place `i`. */
  const giver = (scopes: typeof a, r: number, i: number): string => {
    for (const s of scopes)
      if (s.any[r] === 1 && s.at[i]) {
        const p = s.permissions.find((x) => matches.get(x)![r] === 1);
        if (p !== undefined) return p;
      }
    return "*";
  };
  const gained = new Map<string, AccessPair>();
  const lost = new Map<string, AccessPair>();
  const note = (
    into: Map<string, AccessPair>,
    permission: string,
    i: number
  ) => {
    if (into.size >= SAMPLE) return;
    const pair = { permission, where: whereOfProbe(places[i]!) };
    into.set(accessPairKey(pair), pair);
  };
  for (let r = 0; r < permissions.length; r++)
    for (let i = 0; i < places.length; i++) {
      const now = permitted(a, r, i);
      const was = permitted(b, r, i);
      if (now === was) continue;
      if (now) note(gained, giver(a, r, i), i);
      else note(lost, giver(b, r, i), i);
      if (!examples)
        return { gained: [...gained.values()], lost: [...lost.values()] };
      if (gained.size >= SAMPLE && lost.size >= SAMPLE)
        return { gained: [...gained.values()], lost: [...lost.values()] };
    }
  return { gained: [...gained.values()], lost: [...lost.values()] };
}

/**
 * Where scopes put the app, and as what: each space and project a scope
 * names, as `viewer` when it holds only reads there and `editor` otherwise,
 * and `pod` for an unpinned (pod-wide read) scope. The doors that read a
 * scope's PLACE rather than ask `permits` follow it: the app agent's space
 * memberships, its RBAC floor (`syncAppAgentMemberships`: a read makes it a
 * viewer of the space, a write an editor), and the spaces a facet or capture
 * door narrows to (`grantedWorkspaceIdsOf`). A pod-wide read permits a read
 * in space A, but it never makes the app a member of A.
 */
function placementOf(
  scopes: readonly AppAccessGrantScope[]
): Map<string, "viewer" | "editor"> {
  const out = new Map<string, "viewer" | "editor">();
  for (const s of scopes) {
    const role = s.permissions.every(isReadPermission) ? "viewer" : "editor";
    // Where it stands, read through THE parse. A scope with no space or
    // project is the pod (a pod-wide read) or, for a document's read off
    // the pod-wide list, "anywhere": both stand at the pod here; what they
    // permit there is compared by `permits`.
    const place = parsePlace(s, "app");
    let keys: string[];
    switch (place.kind) {
      case "spaces":
        keys = place.ids.map((id) => `space:${id}`);
        break;
      case "projects":
        keys = place.ids.map((id) => `project:${id}`);
        break;
      case "pod":
      case "unbounded":
        keys = ["pod"];
        break;
      default:
        keys = assertNeverPlace(place);
    }
    for (const k of keys) if (out.get(k) !== "editor") out.set(k, role);
  }
  return out;
}

function whereOfPlacementKey(key: string): AccessWhere {
  if (key === "pod") return { kind: "pod" };
  const [kind, ...rest] = key.split(":");
  return { kind: kind as "space" | "project", id: rest.join(":") };
}

/** Placements of `a` that `b` lacks or holds with a lesser role, as pairs of `a`. */
function placementBeyond(
  a: readonly AppAccessGrantScope[],
  b: readonly AppAccessGrantScope[]
): AccessPair[] {
  const pa = placementOf(a);
  const pb = placementOf(b);
  const out: AccessPair[] = [];
  for (const [key, role] of pa) {
    const other = pb.get(key);
    if (other === role || other === "editor") continue;
    const where = whereOfPlacementKey(key);
    const held = a.find((s) => placementOf([s]).get(key) === role);
    const permission =
      held?.permissions.find((p) =>
        role === "editor" ? !isReadPermission(p) : isReadPermission(p)
      ) ?? "*";
    out.push({ permission, where });
  }
  return out;
}

/**
 * Do two sets of scopes give an app the same reach? The same PERMITS (the
 * engine's `permits`, over the finite probes that decide it) and the same
 * PLACEMENT (each space and project as viewer or editor, and the pod). What
 * the second gives beyond the first is `widens`; what it loses, `narrows`.
 * Throws `LiftTooLargeError` above `LIFT_PROBE_BUDGET`.
 */
export function compareAppScopes(
  before: readonly AppAccessGrantScope[],
  after: readonly AppAccessGrantScope[],
  options: CompareOptions = {}
): { widens: AccessPair[]; narrows: AccessPair[] } {
  const { gained, lost } = permitDiffs(before, after, options);
  const take = (...lists: AccessPair[][]) => {
    const m = new Map<string, AccessPair>();
    for (const l of lists) for (const p of l) m.set(accessPairKey(p), p);
    return [...m.values()];
  };
  return {
    widens: take(gained, placementBeyond(after, before)),
    narrows: take(lost, placementBeyond(before, after)),
  };
}

/** The pieces of a scope: one per permission × named place (W3d). */
function piecesOf(scope: AppAccessGrantScope): AppAccessGrantScope[] {
  const out: AppAccessGrantScope[] = [];
  const ws = scope.workspaceIds?.length ? scope.workspaceIds : null;
  const pj = scope.projectIds?.length ? scope.projectIds : null;
  for (const permission of scope.permissions) {
    if (ws) {
      // Split by space; any other limit stays on each piece (still ⊆ scope).
      for (const id of ws)
        out.push({ ...scope, permissions: [permission], workspaceIds: [id] });
    } else if (pj) {
      for (const id of pj)
        out.push({ ...scope, permissions: [permission], projectIds: [id] });
    } else out.push({ ...scope, permissions: [permission] });
  }
  return out;
}

/**
 * What of `candidates` lies within `bound`, BY MEANING (W3d; review finding 4
 * of #1196): each candidate scope whole when everything it permits `bound`
 * permits too and it puts the app nowhere `bound` does not (each space or
 * project it names as viewer or editor, `placementOf`); otherwise each of its
 * pieces (one permission in one named place) that is. So `entity.note.read`
 * in A is kept beside a bound of `entity.read` in A, which a comparison of
 * literal (permission, space) keys would drop.
 *
 * SOUND: everything the result permits, both sides permit; never wider than
 * either. Asked through the engine's own `permits` over the finite probes of
 * both sides (`probesFor`). Throws `LiftTooLargeError` above
 * `LIFT_PROBE_BUDGET` (the caller fails closed).
 */
export function scopesWithinBound(
  candidates: readonly AppAccessGrantScope[],
  bound: readonly AppAccessGrantScope[]
): AppAccessGrantScope[] {
  if (candidates.length === 0) return [];
  const all = [...candidates, ...bound];
  const distinct = [...new Set(all.flatMap((s) => s.permissions))];
  const { permissions, places } = probesFor(distinct, all);
  const cost = costOf(permissions.length, distinct.length, all);
  if (cost > LIFT_PROBE_BUDGET) throw new LiftTooLargeError(cost);
  const matches = new Map<string, Uint8Array>();
  for (const p of distinct) {
    const row = new Uint8Array(permissions.length);
    for (let r = 0; r < permissions.length; r++)
      row[r] = patternMatches(p, permissions[r]!) ? 1 : 0;
    matches.set(p, row);
  }
  const limitsAt = (s: AppAccessGrantScope) =>
    places.map((pl) =>
      permits(
        { ...s, permissions: ["*"] },
        {
          subject: OTHER,
          action: OTHER_VERB,
          workspaceId: pl.workspaceId ?? null,
          projectIds: pl.projectId === undefined ? null : [pl.projectId],
        }
      )
    );
  // What the bound permits, probe by probe.
  const boundAt = bound.map(limitsAt);
  const permitted = (r: number, i: number) =>
    bound.some(
      (s, k) => boundAt[k]![i] && s.permissions.some((p) => matches.get(p)![r])
    );
  const boundPermits: Uint8Array[] = permissions.map((_, r) => {
    const row = new Uint8Array(places.length);
    for (let i = 0; i < places.length; i++) row[i] = permitted(r, i) ? 1 : 0;
    return row;
  });
  const boundPlaces = placementOf(bound);
  const within = (s: AppAccessGrantScope): boolean => {
    for (const [key, role] of placementOf([s])) {
      const held = boundPlaces.get(key);
      if (!held || (role === "editor" && held !== "editor")) return false;
    }
    const at = limitsAt(s);
    for (let r = 0; r < permissions.length; r++) {
      if (!s.permissions.some((p) => matches.get(p)![r])) continue;
      for (let i = 0; i < places.length; i++)
        if (at[i] && !boundPermits[r]![i]) return false;
    }
    return true;
  };
  const out: AppAccessGrantScope[] = [];
  for (const c of candidates) {
    if (within(c)) {
      out.push(c);
      continue;
    }
    for (const piece of piecesOf(c)) if (within(piece)) out.push(piece);
  }
  return out;
}

/**
 * Lift a connection's `approved_requests` pairs into v2, or say why it must
 * ask again. NEVER WIDENS, NEVER NARROWS: the lift is returned only when the
 * grants its v2 form makes (`grantScopesForAccess`) give the app exactly the
 * reach its pairs give today (`scopesOfPairs`): the same permits, by the
 * engine's own `permits` over every request that can tell them apart, and
 * the same placement (each space as viewer or editor, and the pod).
 *
 * SEMANTIC, not by key (W3c; review of #1183 found the key comparison
 * over-eager): a pair the v2 form adds that the pairs already permit
 * (`entity.note.read` in A beside `entity.read` in A) adds nothing, and a
 * space read beside the same read pod-wide is kept by the pod-wide read
 * while the space stays where the app writes. A row no app may hold, a
 * permit the v2 form would add ("read notes in Sales" and "read tasks in
 * Finance" would read notes in Finance), a permit it would lose (a read off
 * the pod-wide list in one space, beside "all"), or a space it would leave
 * (a space only read in, beside the same read pod-wide: the app stops being
 * its viewer) leaves the connection on its pairs: a re-consent, never a
 * silent change.
 *
 * The v2 DOCUMENT is held to the same bar as its grants: its own pairs
 * (`expandAppAccess`) must permit nothing the grants do not, so a stored
 * `approved_access` never names a read its grants drop. A connection too
 * large to compare within `LIFT_PROBE_BUDGET` re-consents ("too-large",
 * fail closed). `options.examples: false` stops at the first difference,
 * for callers that only need the verdict (the reason is then the first
 * difference met, and the samples hold it alone).
 */
export function liftApprovedRequests(
  requests: readonly PlaceRequestLike[],
  options: CompareOptions = {}
): LiftResult {
  const { pairs, unplaceable } = pairsOfRequests(requests);
  const access = candidateAccess(pairs);
  const refuse = (
    reason: ReconsentReason,
    widens: readonly AccessPair[] = [],
    narrows: readonly AccessPair[] = []
  ): LiftResult => ({
    reconsent: {
      reason,
      widens: widens.slice(0, SAMPLE),
      narrows: narrows.slice(0, SAMPLE),
      unplaceable: unplaceable.length,
    },
  });
  if (unplaceable.length > 0) return refuse("unplaceable");
  let widens: AccessPair[];
  let narrows: AccessPair[];
  try {
    const grants = grantScopesForAccess(access);
    ({ widens, narrows } = compareAppScopes(
      scopesOfPairs(pairs),
      grants,
      options
    ));
    // The v2 DOCUMENT must say what its grants say (review of #1196). Reads
    // with "all" spaces are granted only where they are pod-wide reads
    // (`grantScopesForAccess`), yet the document lists every read at the pod
    // (`expandAppAccess`): `entity.*.read` beside `*` in A and a pod-wide
    // `entity.note.read` would stand in the stored `approved_access` as read
    // at the pod, a phantom `appAccessWithin` would then approve against.
    // So the document's own pairs, read as scopes with no pod-wide filter,
    // must permit nothing its grants do not.
    if (
      widens.length === 0 &&
      narrows.length === 0 &&
      access.read.spaces === "all" &&
      access.permissions.some(
        (p) => isReadPermission(p) && !isPodWideReadPermission(p)
      )
    ) {
      widens = compareAppScopes(
        grants,
        scopesOfPairs(expandAppAccess(access)),
        options
      ).widens;
    }
  } catch (err) {
    if (err instanceof LiftTooLargeError) return refuse("too-large");
    // A permission the grammar cannot read is a row no app may hold.
    if (!(err instanceof InvalidPermissionError)) throw err;
    return {
      reconsent: {
        reason: "unplaceable",
        widens: [],
        narrows: [],
        unplaceable: Math.max(1, unplaceable.length),
      },
    };
  }
  if (widens.length > 0) return refuse("widens", widens, narrows);
  if (narrows.length > 0) return refuse("narrows", widens, narrows);
  return { access };
}

// ── v2 → grant scopes ─────────────────────────────────────────────────────

/** One grant scope an app's key carries (the mint wire shape, `GrantInput`). */
export interface AppAccessGrantScope {
  permissions: string[];
  workspaceIds?: string[];
  projectIds?: string[];
}

/** How a v2 access is minted (`grantScopesForAccess`). */
export interface GrantScopesOptions {
  /**
   * What "all" projects means at this mint: the projects the person can see
   * now (a live pin, re-read at every mint). Omitted: "all" projects mints
   * nothing (fail closed).
   */
  readonly allProjects?: readonly string[];
}

/** A grant names at most this many spaces or projects (`GrantInputSchema`). */
const MAX_IDS_PER_SCOPE = 64;

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_SCOPE)
    out.push(ids.slice(i, i + MAX_IDS_PER_SCOPE));
  return out;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * The grant scopes a v2 access makes — at most four (more only past 64
 * spaces or projects in one list):
 *   - its reads in its read spaces (no space at all for "all": the pod-wide
 *     read, which holds only `isPodWideReadPermission` reads, as today);
 *   - its reads in its read projects (`projectIds`);
 *   - its writes in its write spaces;
 *   - its writes in its write projects.
 * Reads and writes over the same list are one scope (as one approved space
 * is one scope today). Spaces and projects are NEVER in one scope: inside a
 * scope `permits` ANDs its limits (the intersection), and F3 is a union,
 * which only separate scopes give (any scope permits).
 *
 * "all" projects (W3d) is a LIVE pin: the engine has no "every project"
 * limit, and a pod read would be wider, so it is minted as the projects
 * the caller resolves NOW (`options.allProjects`: the projects the person
 * can see when the token is minted). Without them it mints nothing (fail
 * closed). Under All spaces the reads are pod-wide and already reach every
 * project the person reads (Q1), so no project scope is added for reads.
 * The key still acts only within the person's floor (grant ∩ floor).
 */
export function grantScopesForAccess(
  access: AppAccess,
  options: GrantScopesOptions = {}
): AppAccessGrantScope[] {
  const all = options.allProjects ?? [];
  const resolve = (ids: AccessAllOrIds): readonly string[] =>
    ids === "all" ? all : ids;
  const reads = access.permissions.filter(isReadPermission);
  const writes = access.permissions.filter((p) => !isReadPermission(p));
  const out: AppAccessGrantScope[] = [];
  const spaces = (perms: readonly string[], ids: readonly string[]) => {
    if (perms.length === 0) return;
    for (const c of chunks(ids))
      out.push({ permissions: [...perms], workspaceIds: c });
  };
  const projects = (perms: readonly string[], ids: readonly string[]) => {
    if (perms.length === 0) return;
    for (const c of chunks(ids))
      out.push({ permissions: [...perms], projectIds: c });
  };

  // Spaces.
  const readSpaces: AccessAllOrIds = access.read.spaces;
  if (readSpaces === "all") {
    // The pod-wide read: an app holds no other read with no space.
    const podWide = reads.filter(isPodWideReadPermission);
    if (podWide.length > 0) out.push({ permissions: podWide });
    spaces(writes, access.write.spaces);
  } else if (sameSet(readSpaces, access.write.spaces)) {
    spaces([...reads, ...writes], readSpaces);
  } else {
    spaces(reads, readSpaces);
    spaces(writes, access.write.spaces);
  }

  // Projects. Under All spaces the reads already reach every project (Q1).
  const readProjects: readonly string[] =
    readSpaces === "all" ? [] : resolve(access.read.projects);
  if (sameSet(readProjects, access.write.projects)) {
    projects([...reads, ...writes], readProjects);
  } else {
    projects(reads, readProjects);
    projects(writes, access.write.projects);
  }
  return out;
}

// ── approved ⊆ asked, v2 against v2 ───────────────────────────────────────

/**
 * Is every pair `approved` allows within what `asked` allows IN THE SAME
 * PLACE? A pod-wide ask covers the same pod-wide read and never the read in
 * one space (a space read makes the app a member there), exactly as the
 * pairs are compared today (`appRequestsWithin`, app-connect).
 */
export function appAccessWithin(
  approved: AppAccess,
  asked: AppAccess
): boolean {
  return pairsWithin(expandAppAccess(approved), expandAppAccess(asked));
}

/** `approved` pairs, each within some `asked` permission at the same place. */
export function pairsWithin(
  approved: readonly AccessPair[],
  asked: readonly AccessPair[]
): boolean {
  const byWhere = new Map<string, string[]>();
  for (const a of asked) {
    const k = accessWhereKey(a.where);
    const list = byWhere.get(k) ?? [];
    list.push(a.permission);
    byWhere.set(k, list);
  }
  return approved.every((a) =>
    permissionWithin(a.permission, byWhere.get(accessWhereKey(a.where)) ?? [])
  );
}

/** Do two accesses allow exactly the same (permission, place) pairs? */
export function sameAppAccess(a: AppAccess, b: AppAccess): boolean {
  const ka = new Set(
    expandAppAccess(normalizeAppAccess(a)).map(accessPairKey)
  );
  const kb = expandAppAccess(normalizeAppAccess(b)).map(accessPairKey);
  return ka.size === new Set(kb).size && kb.every((k) => ka.has(k));
}

// ── stored v2 ─────────────────────────────────────────────────────────────

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.trim() === "") return null;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function allOrIds(value: unknown): AccessAllOrIds | null {
  return value === "all" ? "all" : idList(value);
}

/**
 * Read a stored `apps.approved_access` value. Anything that is not a whole,
 * valid v2 access reads as null (the reader then lifts the pairs): a write
 * that says "all", a blank id, a missing tier, another version.
 */
export function parseAppAccess(raw: unknown): AppAccess | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== APP_ACCESS_VERSION) return null;
  const permissions = idList(r.permissions);
  const read = r.read as Record<string, unknown> | null | undefined;
  const write = r.write as Record<string, unknown> | null | undefined;
  if (!permissions || !read || typeof read !== "object") return null;
  if (!write || typeof write !== "object") return null;
  const readSpaces = allOrIds(read.spaces);
  const readProjects = allOrIds(read.projects);
  // Writes are Select only (F2): "all" is not a write place.
  const writeSpaces = idList(write.spaces);
  const writeProjects = idList(write.projects);
  if (!readSpaces || !readProjects || !writeSpaces || !writeProjects)
    return null;
  return normalizeAppAccess({
    version: APP_ACCESS_VERSION,
    permissions,
    read: { spaces: readSpaces, projects: readProjects },
    write: { spaces: writeSpaces, projects: writeProjects },
  });
}

/**
 * The one canonical spelling of an access (W3d), so two that mean the same
 * compare equal and the stored document reads the same everywhere:
 * permissions and ids each once, in the order first given; reads in All
 * spaces store NO project list (`projects: []`), because All spaces already
 * includes every project (Q1, decision fc37f740) and a project list beside
 * it would say nothing more. A display shows such reads as "all" projects.
 */
export function normalizeAppAccess(access: AppAccess): AppAccess {
  const once = (ids: readonly string[]) => [...new Set(ids)];
  const readSpaces: AccessAllOrIds =
    access.read.spaces === "all" ? "all" : once(access.read.spaces);
  const readProjects: AccessAllOrIds =
    readSpaces === "all"
      ? []
      : access.read.projects === "all"
        ? "all"
        : once(access.read.projects);
  return {
    version: APP_ACCESS_VERSION,
    permissions: once(access.permissions.map((p) => p.trim())),
    read: { spaces: readSpaces, projects: readProjects },
    write: {
      spaces: once(access.write.spaces),
      projects: once(access.write.projects),
    },
  };
}

// ── one request, many kinds (F4) ──────────────────────────────────────────

/** A request lists at most this many kinds (the 48 cap counts entries, not kinds). */
export const MAX_KINDS_PER_REQUEST = 64;

const KIND_SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** A request's kinds that are not a kind slug; refused before expanding. */
export class KindsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KindsRequestError";
  }
}

/**
 * One request that lists its kinds (decision 51ad8d1e F4), as the per-kind
 * permissions the pod grants: `{permission: "entity.read", kinds: ["note",
 * "task"]}` → `entity.note.read`, `entity.task.read`. Only an every-kind
 * entity permission (`entity.<action>`) takes kinds; each kind is a slug,
 * listed once; at most `MAX_KINDS_PER_REQUEST`. The permission unit stays
 * per kind (D4): this only spells many of them in one entry.
 */
export function permissionsForKinds(
  permission: string,
  kinds: readonly unknown[]
): string[] {
  const segs = permission.trim().split(".");
  if (segs.length !== 2 || segs[0] !== "entity" || segs[1] === "*")
    throw new KindsRequestError(
      `"${permission}" cannot list kinds: only an every-kind record permission (entity.<action>, e.g. entity.read) can`
    );
  if (kinds.length === 0)
    throw new KindsRequestError(`"${permission}" lists no kinds`);
  if (kinds.length > MAX_KINDS_PER_REQUEST)
    throw new KindsRequestError(
      `"${permission}" lists more than ${MAX_KINDS_PER_REQUEST} kinds`
    );
  const out: string[] = [];
  for (const kind of kinds) {
    if (typeof kind !== "string" || !KIND_SLUG.test(kind))
      throw new KindsRequestError(
        `"${permission}" lists a kind that is not a kind slug (lowercase letters, digits, _ and -)`
      );
    const p = `entity.${kind}.${segs[1]}`;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
