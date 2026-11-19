/**
 * The consent SAVES an AppAccess v2 (app permissions W3d, decisions 51ad8d1e
 * F1-F4 and fc37f740 design A, Q1-Q4; plan 8189ae7c §4 W3).
 *
 * The person's choice on the consent screen, the app page and the short ask
 * is a v2 access, stored FIRST (`apps.approved_access`). Before it is stored
 * it must lie within what the app ASKED and what the person may GIVE (their
 * floor), the ceiling below. Pure: no I/O; the api layer reads the ceiling
 * from the app's document and the person's spaces and projects.
 *
 * The rules (each enforced by `appAccessBeyond`):
 *  1. Every permission was asked (exactly, as the offer lists it).
 *  2. Reads in All spaces only for reads the app declared pod-wide that are
 *     a pod-wide read (D1, decision e1b59d38 "B"). All spaces includes every
 *     project (Q1).
 *  3. Reads in named spaces / projects: only places the person may give a
 *     read in. "all" projects is a live pin, always within (it is minted as
 *     the projects the person can see at each mint, `grantScopesForAccess`).
 *  4. Writes are Select only (the type has no "all"), and only in places the
 *     person may give a write in.
 * Whatever passes is minted exactly (`grantScopesForAccess`); the document
 * and its grants permit the same (no phantom, pod knowledge 557a96de).
 */

import { isPodWideReadPermission } from "./pod-wide.js";
import {
  APP_ACCESS_VERSION,
  isReadPermission,
  normalizeAppAccess,
  type AccessAllOrIds,
  type AccessWhere,
  type AppAccess,
  type AppAccessGrantScope,
} from "./app-access.js";

// ── the ceiling: what was asked ∩ what the person may give ───────────────

/** What an app may be given by one person, read from its ask and their floor. */
export interface AppAccessCeiling {
  /** Every permission the app asked for (and declared), each exactly. */
  readonly permissions: readonly string[];
  /**
   * The asked reads that may hold in All spaces: declared pod-wide by the app
   * AND a pod-wide read (`isPodWideReadPermission`).
   */
  readonly allSpacesReads: readonly string[];
  /** Where the person may give a read. */
  readonly read: {
    readonly spaces: readonly string[];
    readonly projects: readonly string[];
  };
  /** Where the person may give a write. */
  readonly write: {
    readonly spaces: readonly string[];
    readonly projects: readonly string[];
  };
}

/** Why one part of an access is beyond its ceiling. */
export type AccessBeyondReason =
  /** The app did not ask for this permission. */
  | "not-asked"
  /** A read in All spaces the app did not declare pod-wide, or no pod-wide read. */
  | "not-all-spaces"
  /** A place the person may not give this tier in. */
  | "not-offered";

/** One part of an access beyond its ceiling. */
export interface AccessBeyond {
  readonly reason: AccessBeyondReason;
  /** The permission, when the refusal is about one. */
  readonly permission: string | null;
  /** The place, when the refusal is about one. */
  readonly where: AccessWhere | null;
  /** The tier the place was chosen for. */
  readonly tier: "read" | "write" | null;
}

/**
 * Everything in `access` beyond `ceiling` (rules 1-4 above); `[]` = within.
 * The access is read in its canonical form (`normalizeAppAccess`). A place in
 * a tier with no permission of that tier still has to be within (it grants
 * nothing, but it is what the person chose and is stored).
 */
export function appAccessBeyond(
  access: AppAccess,
  ceiling: AppAccessCeiling
): AccessBeyond[] {
  const a = normalizeAppAccess(access);
  const out: AccessBeyond[] = [];
  // NEGATIVE CONTROL: the ceiling check removed.
  if (a) return out;
  const asked = new Set(ceiling.permissions);
  const allSpaces = new Set(
    ceiling.allSpacesReads.filter(
      (p) => asked.has(p) && isPodWideReadPermission(p)
    )
  );
  for (const permission of a.permissions) {
    if (!asked.has(permission))
      out.push({ reason: "not-asked", permission, where: null, tier: null });
  }
  if (a.read.spaces === "all") {
    for (const permission of a.permissions.filter(isReadPermission)) {
      if (!allSpaces.has(permission))
        out.push({
          reason: "not-all-spaces",
          permission,
          where: { kind: "pod" },
          tier: "read",
        });
    }
  }
  const places = (
    tier: "read" | "write",
    kind: "space" | "project",
    chosen: AccessAllOrIds,
    offered: readonly string[]
  ) => {
    if (chosen === "all") return;
    const ok = new Set(offered);
    for (const id of chosen)
      if (!ok.has(id))
        out.push({
          reason: "not-offered",
          permission: null,
          where: { kind, id },
          tier,
        });
  };
  places("read", "space", a.read.spaces, ceiling.read.spaces);
  places("read", "project", a.read.projects, ceiling.read.projects);
  places("write", "space", a.write.spaces, ceiling.write.spaces);
  places("write", "project", a.write.projects, ceiling.write.projects);
  return out;
}

/**
 * The grant scopes the ceiling itself would give: the widest any access
 * within it may ever mint (the reference the never-widen tests compare
 * against). Reads in the person's readable spaces and projects, the
 * pod-wide-declared reads unpinned, writes in their writable spaces and
 * projects. Spaces and projects never share a scope.
 */
export function ceilingScopes(
  ceiling: AppAccessCeiling
): AppAccessGrantScope[] {
  const reads = ceiling.permissions.filter(isReadPermission);
  const writes = ceiling.permissions.filter((p) => !isReadPermission(p));
  const allSpaces = ceiling.allSpacesReads.filter(
    (p) => reads.includes(p) && isPodWideReadPermission(p)
  );
  const out: AppAccessGrantScope[] = [];
  const add = (
    permissions: readonly string[],
    key: "workspaceIds" | "projectIds" | null,
    ids: readonly string[]
  ) => {
    if (permissions.length === 0) return;
    if (key === null) out.push({ permissions: [...permissions] });
    else if (ids.length > 0)
      out.push({ permissions: [...permissions], [key]: [...ids] });
  };
  add(reads, "workspaceIds", ceiling.read.spaces);
  add(reads, "projectIds", ceiling.read.projects);
  add(allSpaces, null, []);
  add(writes, "workspaceIds", ceiling.write.spaces);
  add(writes, "projectIds", ceiling.write.projects);
  return out;
}

/**
 * What the access DOCUMENT says, read as scopes with no pod-wide filter:
 * every read where `read` says (All spaces unpinned, "all" projects as
 * `allProjects`), every write where `write` says. Compared with
 * `grantScopesForAccess` it shows a phantom (a document wider than its
 * grants, pod knowledge 557a96de); a valid access has none.
 */
export function documentScopes(
  access: AppAccess,
  allProjects: readonly string[] = []
): AppAccessGrantScope[] {
  const a = normalizeAppAccess(access);
  const reads = a.permissions.filter(isReadPermission);
  const writes = a.permissions.filter((p) => !isReadPermission(p));
  const out: AppAccessGrantScope[] = [];
  const add = (
    permissions: readonly string[],
    key: "workspaceIds" | "projectIds" | null,
    ids: AccessAllOrIds
  ) => {
    if (permissions.length === 0) return;
    if (key === null) {
      out.push({ permissions: [...permissions] });
      return;
    }
    const list = ids === "all" ? allProjects : ids;
    if (list.length > 0)
      out.push({ permissions: [...permissions], [key]: [...list] });
  };
  if (a.read.spaces === "all") add(reads, null, []);
  else {
    add(reads, "workspaceIds", a.read.spaces);
    add(reads, "projectIds", a.read.projects);
  }
  add(writes, "workspaceIds", a.write.spaces);
  add(writes, "projectIds", a.write.projects);
  return out;
}

/** Does the access give anything at all (a permission in some place)? */
export function appAccessGivesAnything(access: AppAccess): boolean {
  const a = normalizeAppAccess(access);
  const reads = a.permissions.some(isReadPermission);
  const writes = a.permissions.some((p) => !isReadPermission(p));
  const somewhere = (ids: AccessAllOrIds) => ids === "all" || ids.length > 0;
  return (
    (reads && (somewhere(a.read.spaces) || somewhere(a.read.projects))) ||
    (writes && (a.write.spaces.length > 0 || a.write.projects.length > 0))
  );
}

// ── the old pairs, derived from v2 for what still reads them ─────────────

/** One old (permission, space | pod) pair. */
export interface AccessCompatPair {
  readonly permission: string;
  /** A space, or null for a pod-wide read. */
  readonly workspaceId: string | null;
}

/**
 * The old `approved_requests` pairs of a v2 access, for the readers that
 * still read them (W5 removes them): its SPACE part, each read in each read
 * space (a pod-wide pair for each read under All spaces), each write in each
 * write space. Never wider than the access (the project part is left out,
 * a pair cannot name a project). `exact`: the pairs say everything the
 * access says (it names no project, and under All spaces it has only
 * pod-wide reads, which its pairs hold as pod pairs).
 */
export function pairsOfAccess(access: AppAccess): {
  pairs: AccessCompatPair[];
  exact: boolean;
} {
  const a = normalizeAppAccess(access);
  const pairs: AccessCompatPair[] = [];
  let exact = true;
  for (const permission of a.permissions) {
    if (isReadPermission(permission)) {
      if (a.read.spaces === "all") {
        // All spaces (projects included, Q1): a pod pair, as today.
        if (isPodWideReadPermission(permission))
          pairs.push({ permission, workspaceId: null });
        else exact = false;
        continue;
      }
      for (const id of a.read.spaces)
        pairs.push({ permission, workspaceId: id });
      if (a.read.projects === "all" || a.read.projects.length > 0)
        exact = false;
    } else {
      for (const id of a.write.spaces)
        pairs.push({ permission, workspaceId: id });
      if (a.write.projects.length > 0) exact = false;
    }
  }
  return { pairs, exact };
}

// ── the short ask: it only adds permissions (Q4) ─────────────────────────

/** Where a short ask's first write lands (Q4): the person's pick. */
export interface AccessWritePlace {
  readonly spaces: readonly string[];
  readonly projects: readonly string[];
}

/** Does the access hold a write place yet (a space or a project)? */
export function hasWritePlace(access: AppAccess): boolean {
  return access.write.spaces.length > 0 || access.write.projects.length > 0;
}

/** Does the access hold a read place yet? */
export function hasReadPlace(access: AppAccess): boolean {
  const some = (ids: AccessAllOrIds) => ids === "all" || ids.length > 0;
  return some(access.read.spaces) || some(access.read.projects);
}

/**
 * The short ask (`synap_ask`, design A): the access with `permissions`
 * added, each in the places its tier ALREADY holds; the places do not change
 * (Q4 aside). The one exception (Q4): an app with no write place that asks a
 * write gets the write place the person picks (`writePlace`), and only then.
 * A read asked by an app with no read place has nowhere to hold: it is
 * refused (`noReadPlace`). Returns the new access, or what is missing.
 */
export function addPermissionsToAccess(
  access: AppAccess,
  permissions: readonly string[],
  writePlace?: AccessWritePlace | null
):
  | { readonly access: AppAccess }
  | { readonly needsWritePlace: true }
  | { readonly noReadPlace: readonly string[] }
  | { readonly writePlaceNotNeeded: true } {
  const a = normalizeAppAccess(access);
  const added = permissions.filter((p) => !a.permissions.includes(p));
  const asksWrite = added.some((p) => !isReadPermission(p));
  const needsWrite = asksWrite && !hasWritePlace(a);
  if (writePlace && !needsWrite) return { writePlaceNotNeeded: true };
  if (needsWrite) {
    if (
      !writePlace ||
      (writePlace.spaces.length === 0 && writePlace.projects.length === 0)
    )
      return { needsWritePlace: true };
  }
  const reads = added.filter(isReadPermission);
  if (reads.length > 0 && !hasReadPlace(a)) return { noReadPlace: reads };
  return {
    access: normalizeAppAccess({
      version: APP_ACCESS_VERSION,
      permissions: [...a.permissions, ...added],
      read: a.read,
      write:
        needsWrite && writePlace
          ? {
              spaces: [...writePlace.spaces],
              projects: [...writePlace.projects],
            }
          : a.write,
    }),
  };
}

// ── named, for every screen (never a raw id alone) ───────────────────────

/** A space as a screen shows it. */
export interface NamedSpace {
  readonly id: string;
  readonly name: string;
  /** The template it was made from (`workspaces.package_slug`), or null. */
  readonly templateSlug: string | null;
}

/** A project as a screen shows it. */
export interface NamedProject {
  readonly id: string;
  readonly name: string;
  /** Its home space, or null for a project in no space. */
  readonly workspaceId: string | null;
}

/** A v2 access with names: what a screen shows. */
export interface NamedAppAccess {
  readonly version: typeof APP_ACCESS_VERSION;
  readonly permissions: readonly string[];
  readonly read: {
    readonly spaces: "all" | readonly NamedSpace[];
    /** "all" under All spaces too (Q1: every project is included). */
    readonly projects: "all" | readonly NamedProject[];
  };
  readonly write: {
    readonly spaces: readonly NamedSpace[];
    readonly projects: readonly NamedProject[];
  };
}

/** One old pair a re-consent shows as "was", with its place named. */
export interface ReconsentWas {
  readonly permission: string;
  readonly place: {
    readonly kind: "space" | "pod" | "project";
    /** null for the pod. */
    readonly id: string | null;
    readonly name: string;
  };
}

/** Why a connection asks again, as a screen shows it (Q3). */
export interface ReconsentView {
  readonly reason: "widens" | "narrows" | "unplaceable" | "too-large";
  /** What it holds now, pair by pair, named. */
  readonly was: readonly ReconsentWas[];
  /** The v2 pre-fill, clamped to what the person may give now. */
  readonly proposed: NamedAppAccess;
}

/**
 * An access clamped to a ceiling: what is beyond is dropped, never added
 * (the re-consent's pre-fill). Reads under All spaces that may not be there
 * keep the read spaces the person may give instead.
 */
export function clampAppAccess(
  access: AppAccess,
  ceiling: AppAccessCeiling
): AppAccess {
  const a = normalizeAppAccess(access);
  const asked = new Set(ceiling.permissions);
  const permissions = a.permissions.filter((p) => asked.has(p));
  const allSpaces = new Set(
    ceiling.allSpacesReads.filter(isPodWideReadPermission)
  );
  const readsAllOk = permissions
    .filter(isReadPermission)
    .every((p) => allSpaces.has(p));
  const keep = (ids: AccessAllOrIds, offered: readonly string[]) =>
    ids === "all" ? "all" : ids.filter((id) => offered.includes(id));
  const readSpaces: AccessAllOrIds =
    a.read.spaces === "all"
      ? readsAllOk
        ? "all"
        : [...ceiling.read.spaces]
      : keep(a.read.spaces, ceiling.read.spaces);
  return normalizeAppAccess({
    version: APP_ACCESS_VERSION,
    permissions,
    read: {
      spaces: readSpaces,
      projects:
        a.read.spaces === "all" && readSpaces !== "all"
          ? "all"
          : keep(a.read.projects, ceiling.read.projects),
    },
    write: {
      spaces: a.write.spaces.filter((id) => ceiling.write.spaces.includes(id)),
      projects: a.write.projects.filter((id) =>
        ceiling.write.projects.includes(id)
      ),
    },
  });
}
