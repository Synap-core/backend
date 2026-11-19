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
 * lift is LOSSLESS: it is refused (re-consent) unless the v2 form allows
 * exactly the (permission, place) pairs the old rows held, no more and no
 * fewer. So reading v2 or the pairs gives the same grants
 * (`grantScopesForAccess` against the pairs' grants, app-access.test.ts).
 *
 * Pure: no I/O.
 */

import { isPodWideReadPermission } from "./pod-wide.js";
import { permissionWithin } from "./algebra.js";
import {
  parseRequestPlace,
  PlaceError,
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
  | "narrows";

export interface Reconsent {
  /** The first reason found, in the order unplaceable, widens, narrows. */
  readonly reason: ReconsentReason;
  /** What the v2 form would allow that the rows did not (at most 5). */
  readonly widens: readonly AccessPair[];
  /** What the rows hold that the v2 form would lose (at most 5). */
  readonly narrows: readonly AccessPair[];
  /** How many rows no app may hold. */
  readonly unplaceable: number;
}

export type LiftResult =
  | { readonly access: AppAccess }
  | { readonly reconsent: Reconsent };

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
 * Lift a connection's `approved_requests` pairs into v2, or say why it must
 * ask again. NEVER WIDENS: the lift is returned only when its v2 form allows
 * exactly the (permission, place) pairs the rows held — so the grants it
 * makes (`grantScopesForAccess`) are the grants the pairs make today. A row
 * no app may hold, a pair the v2 form would add ("read notes in Sales" and
 * "read tasks in Finance" would read notes in Finance), or a pair it would
 * lose (a read in one space beside the same kind of read pod-wide) leaves
 * the connection on its pairs: a re-consent, never a silent change.
 */
export function liftApprovedRequests(
  requests: readonly PlaceRequestLike[]
): LiftResult {
  const { pairs, unplaceable } = pairsOfRequests(requests);
  const access = candidateAccess(pairs);
  const held = new Set(pairs.map(accessPairKey));
  const allowed = expandAppAccess(access);
  const allowedKeys = new Set(allowed.map(accessPairKey));
  const widens = allowed.filter((p) => !held.has(accessPairKey(p)));
  const narrows = pairs.filter((p) => !allowedKeys.has(accessPairKey(p)));
  if (unplaceable.length > 0 || widens.length > 0 || narrows.length > 0) {
    return {
      reconsent: {
        reason:
          unplaceable.length > 0
            ? "unplaceable"
            : widens.length > 0
              ? "widens"
              : "narrows",
        widens: widens.slice(0, SAMPLE),
        narrows: narrows.slice(0, SAMPLE),
        unplaceable: unplaceable.length,
      },
    };
  }
  return { access };
}

// ── v2 → grant scopes ─────────────────────────────────────────────────────

/** One grant scope an app's key carries (the mint wire shape, `GrantInput`). */
export interface AppAccessGrantScope {
  permissions: string[];
  workspaceIds?: string[];
  projectIds?: string[];
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
 * which only separate scopes give (any scope permits). "all" projects makes no scope yet: the engine has no
 * "every project" pin, and a pod read would be wider (fail closed; W3).
 * The key still acts only within the person's floor (grant ∩ floor).
 */
export function grantScopesForAccess(
  access: AppAccess
): AppAccessGrantScope[] {
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

  // Projects.
  const readProjects: AccessAllOrIds = access.read.projects;
  if (readProjects === "all") {
    projects(writes, access.write.projects);
  } else if (sameSet(readProjects, access.write.projects)) {
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
  const ka = new Set(expandAppAccess(a).map(accessPairKey));
  const kb = expandAppAccess(b).map(accessPairKey);
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
  return {
    version: APP_ACCESS_VERSION,
    permissions,
    read: { spaces: readSpaces, projects: readProjects },
    write: { spaces: writeSpaces, projects: writeProjects },
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
