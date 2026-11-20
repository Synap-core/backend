/**
 * The consent as design A draws it (ui-design 814c0b8d, decision fc37f740):
 * three lines, "It can", "In" and "It changes things in", over ONE draft
 * that has the shape of AppAccess v2 (`@synap-core/types/grants`): what it
 * may do, where it reads (spaces "all" or a list, projects "all" or a list),
 * where it writes (a list of spaces and projects, never "all"). Pure, so
 * every rule of the screen is tested without a browser.
 *
 * The offer still bounds everything, as before (`consent-model`): a draft
 * never holds a permission, a space or a project the server did not offer,
 * and `toAccess` filters to the offer again before anything is sent.
 *
 * Today's server sends the offer per permission (`permissions[].workspaces`
 * plus `podWide`), with #1196's `kindGroup` and `projects` when present.
 * `offerOf` is the one adapter from that wire to this model; the W3d
 * contract (consent context with the current AppAccess and the re-consent
 * payload) plugs in here, not in the components.
 */

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import {
  APP_ACCESS_VERSION,
  expandAppAccess,
  FULL_ACCESS_LABEL,
  candidateAccess,
  grantKindLabel,
  isPodWideReadPermission,
  isReadPermission,
  liftApprovedRequests,
  pairsOfRequests,
  type AccessAllOrIds,
  type AccessPair,
  type AppAccess,
} from "@synap-core/types/grants";
import {
  ALSO_SEE,
  groupByObject,
  isDecisionPermission,
  isReadOnlyPermission,
  permissionLabel,
  PRESELECT_DECISIONS,
  type AccessLevel,
  type ActsAs,
  type ConsentObject,
  type OfferedPermission,
  type OfferedSpace,
} from "./consent-model";
import { consentT } from "./copy";

// ─── The offer ───────────────────────────────────────────────────────────────

/** One F4 entry as declared: `{ permission: "entity.read", kinds }`. */
export interface KindGroup {
  permission: string;
  kinds: string[];
}

/** A project the person may give a permission in (#1196). */
export interface OfferedProject {
  projectId: string;
  projectName: string;
  /** Its home space, or null for a project in no space. */
  workspaceId: string | null;
}

/** One permission on offer, wherever it may be given. */
export interface OfferItem {
  permission: string;
  /** The developer's own words, as text; null when none was sent. */
  reason: string | null;
  /** The F4 entry it was declared in, or null (#1196 `kindGroup`). */
  kindGroup: KindGroup | null;
  /** The spaces it may be given in. */
  spaces: OfferedSpace[];
  /** The projects it may be given in (#1196; empty before it). */
  projects: OfferedProject[];
  /** It may be given everywhere in the pod (the server's `podWide`). */
  podWide: boolean;
}

/** The consent context's `app`, as much of it as this model reads. */
export interface ConsentAppWire {
  permissions: ReadonlyArray<{
    permission: string;
    workspaces: ReadonlyArray<OfferedSpace>;
    reason?: string | null;
    kindGroup?: KindGroup | null;
    projects?: ReadonlyArray<OfferedProject>;
  }>;
  podWide: ReadonlyArray<{
    permission: string;
    reason?: string | null;
    kindGroup?: KindGroup | null;
  }>;
  templates: readonly string[];
}

export interface ConsentOffer {
  items: OfferItem[];
  /** The workspace templates the app declared (`synap_templates`). */
  templates: string[];
  /**
   * The server offers projects (#1196 sends `projects` on each item). Before
   * it, the Projects choice is omitted rather than shown empty: "You have no
   * projects" would be a guess.
   */
  projectsOffered: boolean;
}

const trimmed = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

/**
 * THE adapter from the consent context to this model: per-space items, then
 * pod-wide items, each once. A permission both offered per space and pod-wide
 * (never sent today) merges into one item.
 */
export function offerOf(app: ConsentAppWire): ConsentOffer {
  const byPermission = new Map<string, OfferItem>();
  for (const p of app.permissions) {
    byPermission.set(p.permission, {
      permission: p.permission,
      reason: trimmed(p.reason),
      kindGroup: p.kindGroup ?? null,
      spaces: [...p.workspaces],
      projects: [...(p.projects ?? [])],
      podWide: false,
    });
  }
  for (const p of app.podWide) {
    const known = byPermission.get(p.permission);
    if (known) {
      known.podWide = true;
      continue;
    }
    byPermission.set(p.permission, {
      permission: p.permission,
      reason: trimmed(p.reason),
      kindGroup: p.kindGroup ?? null,
      spaces: [],
      projects: [],
      podWide: true,
    });
  }
  return {
    items: [...byPermission.values()],
    templates: [...app.templates],
    projectsOffered: app.permissions.some((p) => Array.isArray(p.projects)),
  };
}

/** It may be given somewhere: a space, a project or the whole pod. */
export function givable(item: OfferItem): boolean {
  return item.podWide || item.spaces.length > 0 || item.projects.length > 0;
}

/** A write tier permission: anything but a read (AppAccess v2's own split). */
export const isWriteTier = (permission: string) =>
  !isReadPermission(permission);

function uniqueBy<T>(list: readonly T[], id: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of list) {
    const k = id(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** The places one tier may be given in: every space and project any item of it is offered in. */
export interface TierChoices {
  spaces: OfferedSpace[];
  projects: OfferedProject[];
  /** A read of this tier may be given everywhere (pod-wide), so "All spaces" is offered. */
  everywhere: boolean;
}

/** Where its reads may be given: "All spaces" needs a pod-wide read on offer. */
export function readChoices(offer: ConsentOffer): TierChoices {
  const reads = offer.items.filter((i) => !isWriteTier(i.permission));
  return {
    spaces: uniqueBy(
      reads.flatMap((i) => i.spaces),
      (s) => s.workspaceId
    ),
    projects: uniqueBy(
      reads.flatMap((i) => i.projects),
      (p) => p.projectId
    ),
    everywhere: reads.some((i) => i.podWide),
  };
}

/** Where its changes may be given: only the places a write is offered in. */
export function writeChoices(offer: ConsentOffer): TierChoices {
  const writes = offer.items.filter((i) => isWriteTier(i.permission));
  return {
    spaces: uniqueBy(
      writes.flatMap((i) => i.spaces),
      (s) => s.workspaceId
    ),
    projects: uniqueBy(
      writes.flatMap((i) => i.projects),
      (p) => p.projectId
    ),
    everywhere: false,
  };
}

/**
 * The spaces it may read in but never change things in: absent from the
 * write picker, named in one sentence ("you can only view them").
 */
export function viewOnlySpaces(offer: ConsentOffer): OfferedSpace[] {
  const writable = new Set(
    writeChoices(offer).spaces.map((s) => s.workspaceId)
  );
  return readChoices(offer).spaces.filter((s) => !writable.has(s.workspaceId));
}

/** Every space and project name on offer, by id, for the sentences. */
export function placeNames(offer: ConsentOffer): Record<string, string> {
  const names: Record<string, string> = {};
  for (const i of offer.items) {
    for (const s of i.spaces) names[s.workspaceId] = s.workspaceName;
    for (const p of i.projects) names[p.projectId] = p.projectName;
  }
  return names;
}

// ─── The draft ───────────────────────────────────────────────────────────────

/** What the person is about to give: AppAccess v2's shape, being edited. */
export interface ConsentDraft {
  /** The permissions it may use, a subset of the offer's. */
  permissions: ReadonlySet<string>;
  read: { spaces: AccessAllOrIds; projects: AccessAllOrIds };
  write: { spaces: readonly string[]; projects: readonly string[] };
}

/** The template spaces among these, or null when the app declared none here. */
function templateSpaces(
  spaces: readonly OfferedSpace[],
  templates: readonly string[]
): string[] {
  return spaces
    .filter((s) => !!s.templateSlug && templates.includes(s.templateSlug))
    .map((s) => s.workspaceId);
}

/**
 * What a FIRST consent starts with (design A §2):
 *  - It can: everything it asks for that can be given, decisions only if
 *    `PRESELECT_DECISIONS` (never, today);
 *  - In: "All spaces" (with every project, decision fc37f740 Q1) when it asks
 *    to read anything pod-wide; else its template spaces, else every space
 *    its reads are offered in (as today's first consent); no projects;
 *  - It changes things in: its template spaces, and only for an app Synap
 *    checked (`verified`): an unverified app names any template it likes, so
 *    a template is no reason to pre-tick a place it may change. Otherwise
 *    nothing (ui-composition §13; the contract's `suggestedSpaceIds`), and
 *    Allow says why.
 */
export function firstDraft(
  offer: ConsentOffer,
  opts: { verified?: boolean } = {}
): ConsentDraft {
  const permissions = new Set<string>();
  for (const item of offer.items) {
    if (!givable(item)) continue;
    if (!PRESELECT_DECISIONS && isDecisionPermission(item.permission)) continue;
    permissions.add(item.permission);
  }
  const reads = readChoices(offer);
  const fromTemplates = templateSpaces(reads.spaces, offer.templates);
  const writeTemplates =
    opts.verified === false
      ? []
      : templateSpaces(writeChoices(offer).spaces, offer.templates);
  return {
    permissions,
    read: reads.everywhere
      ? { spaces: "all", projects: "all" }
      : {
          spaces:
            fromTemplates.length > 0
              ? fromTemplates
              : reads.spaces.map((s) => s.workspaceId),
          projects: [],
        },
    write: { spaces: writeTemplates, projects: [] },
  };
}

/** A draft from an access the connection already holds (re-consent, the app page). */
export function draftOf(access: AppAccess): ConsentDraft {
  return {
    permissions: new Set(access.permissions),
    read: {
      spaces: access.read.spaces === "all" ? "all" : [...access.read.spaces],
      projects:
        access.read.projects === "all" ? "all" : [...access.read.projects],
    },
    write: {
      spaces: [...access.write.spaces],
      projects: [...access.write.projects],
    },
  };
}

/**
 * What Allow sends, as AppAccess v2, filtered to the offer: only offered
 * permissions, in offer order; only offered places. "All spaces" includes
 * every project (decision fc37f740 Q1). A write place is never "all". Under
 * "All spaces", a read with no pod-wide form (W3d contract `allSpaces:
 * false`) is not sent: it holds only in picked spaces, and the screen says so
 * beside "It can" (`notEverywhere`). A tier with no permission sent carries
 * no place: no invisible write (or read) place is ever stored.
 */
export function toAccess(draft: ConsentDraft, offer: ConsentOffer): AppAccess {
  const reads = readChoices(offer);
  const everywhere = draft.read.spaces === "all" && reads.everywhere;
  const permissions = offer.items
    .filter((i) => givable(i) && draft.permissions.has(i.permission))
    .filter((i) => !everywhere || isWriteTier(i.permission) || i.podWide)
    .map((i) => i.permission);
  const writes = writeChoices(offer);
  const within = (ids: readonly string[], allowed: readonly string[]) =>
    ids.filter((id, n) => allowed.includes(id) && ids.indexOf(id) === n);
  const readsSent = permissions.some((p) => !isWriteTier(p));
  const writesSent = permissions.some(isWriteTier);
  const readSpaces: AccessAllOrIds = !readsSent
    ? []
    : draft.read.spaces === "all"
      ? reads.everywhere
        ? "all"
        : reads.spaces.map((s) => s.workspaceId)
      : within(
          draft.read.spaces,
          reads.spaces.map((s) => s.workspaceId)
        );
  const readProjects: AccessAllOrIds = !readsSent
    ? []
    : readSpaces === "all" || draft.read.projects === "all"
      ? "all"
      : within(
          draft.read.projects,
          reads.projects.map((p) => p.projectId)
        );
  return {
    version: APP_ACCESS_VERSION,
    permissions,
    read: { spaces: readSpaces, projects: readProjects },
    write: writesSent
      ? {
          spaces: within(
            draft.write.spaces,
            writes.spaces.map((s) => s.workspaceId)
          ),
          projects: within(
            draft.write.projects,
            writes.projects.map((p) => p.projectId)
          ),
        }
      : { spaces: [], projects: [] },
  };
}

/**
 * The same draft lowered to today's wire (`approved` pairs), until the W3d
 * contract takes AppAccess v2: each read in each read space it is offered in,
 * or pod-wide when "All spaces" and it may be read pod-wide; each write in
 * each write space it is offered in. Projects and "spaces you create later"
 * have no pair form: they are sent once the contract carries v2.
 */
export function toApprovedPairs(
  draft: ConsentDraft,
  offer: ConsentOffer
): Array<{ permission: string; workspaceId: string | null }> {
  const access = toAccess(draft, offer);
  const out: Array<{ permission: string; workspaceId: string | null }> = [];
  for (const item of offer.items) {
    if (!access.permissions.includes(item.permission)) continue;
    const read = !isWriteTier(item.permission);
    if (read && access.read.spaces === "all") {
      if (item.podWide) {
        out.push({ permission: item.permission, workspaceId: null });
        continue;
      }
      for (const s of item.spaces)
        out.push({ permission: item.permission, workspaceId: s.workspaceId });
      continue;
    }
    const places = read
      ? (access.read.spaces as readonly string[])
      : access.write.spaces;
    for (const s of item.spaces)
      if (places.includes(s.workspaceId))
        out.push({ permission: item.permission, workspaceId: s.workspaceId });
  }
  return out;
}

// ─── Editing the places ──────────────────────────────────────────────────────

/**
 * "All spaces" or "Only the spaces I pick". All includes every project
 * (decision fc37f740 Q1). Leaving All starts from the app's template spaces
 * (its declared default), else from nothing, with no project: the person
 * picks; nothing wider is kept by accident.
 */
export function setReadSpacesMode(
  draft: ConsentDraft,
  offer: ConsentOffer,
  mode: "all" | "pick"
): ConsentDraft {
  if (mode === "all") {
    return { ...draft, read: { spaces: "all", projects: "all" } };
  }
  if (draft.read.spaces !== "all") return draft;
  return {
    ...draft,
    read: {
      spaces: templateSpaces(readChoices(offer).spaces, offer.templates),
      projects: [],
    },
  };
}

const flip = (ids: readonly string[], id: string) =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];

/** One space ticked or unticked in "Only the spaces I pick". */
export function toggleReadSpace(draft: ConsentDraft, id: string): ConsentDraft {
  if (draft.read.spaces === "all") return draft;
  return {
    ...draft,
    read: { ...draft.read, spaces: flip(draft.read.spaces, id) },
  };
}

/** "All projects", "Only the projects I pick" or "No projects". */
export function setReadProjectsMode(
  draft: ConsentDraft,
  mode: "all" | "pick" | "none"
): ConsentDraft {
  if (draft.read.spaces === "all") return draft;
  const projects =
    mode === "all"
      ? "all"
      : mode === "none"
        ? []
        : draft.read.projects === "all"
          ? []
          : draft.read.projects;
  return { ...draft, read: { ...draft.read, projects } };
}

/** Which Projects choice the draft holds. */
export function readProjectsMode(
  draft: ConsentDraft,
  picking: boolean
): "all" | "pick" | "none" {
  const p = draft.read.projects;
  if (p === "all") return "all";
  return p.length > 0 || picking ? "pick" : "none";
}

/** One project ticked or unticked in "Only the projects I pick". */
export function toggleReadProject(
  draft: ConsentDraft,
  id: string
): ConsentDraft {
  const p = draft.read.projects;
  if (p === "all") return draft;
  return { ...draft, read: { ...draft.read, projects: flip(p, id) } };
}

/** One write place ticked or unticked: a space or a project, never "all". */
export function toggleWritePlace(
  draft: ConsentDraft,
  kind: "space" | "project",
  id: string
): ConsentDraft {
  return {
    ...draft,
    write:
      kind === "space"
        ? { ...draft.write, spaces: flip(draft.write.spaces, id) }
        : { ...draft.write, projects: flip(draft.write.projects, id) },
  };
}

/** One permission turned on or off (a re-consent's narrowing door, its Undo). */
export function setPermission(
  draft: ConsentDraft,
  permission: string,
  on: boolean
): ConsentDraft {
  const next = new Set(draft.permissions);
  if (on) next.add(permission);
  else next.delete(permission);
  return { ...draft, permissions: next };
}

// ─── It can: the rows ────────────────────────────────────────────────────────

/** The F4 row's key: one row for every permission declared with its kinds. */
export const KINDS_ROW = "records";

/** A row of "It can": today's object rows, plus ONE row for the F4 kinds. */
export interface CanRow extends ConsentObject {
  /** For the F4 row: each kind it asked for, with its permissions. */
  kinds: Array<{ kind: string; label: string; permissions: string[] }>;
}

/** The permission's kind when it is `entity.<kind>.<verb>`, else null. */
function kindOf(permission: string): string | null {
  const m = /^entity\.([a-z0-9][a-z0-9_-]*)\.[a-z_]+$/.exec(permission);
  return m && m[1] !== "*" ? m[1]! : null;
}

/**
 * The offer as rows. Every permission declared with its kinds (#1196's
 * `kindGroup`) is ONE row "Records · N kinds" (design A, "KindsGroupRow"),
 * first; the rest is today's `groupByObject` (full access, edits, "It can also
 * see", decisions). Permissions that cannot be given anywhere are left out:
 * they are named under "It also asked for… you can't give" (`cantGive`).
 */
export function canRows(offer: ConsentOffer, actsAs: ActsAs): CanRow[] {
  const items = offer.items.filter(givable);
  const grouped = items.filter((i) => i.kindGroup && kindOf(i.permission));
  const rest = items.filter((i) => !grouped.includes(i));
  const asOffered = (list: readonly OfferItem[]): OfferedPermission[] =>
    list.map((i) => ({
      permission: i.permission,
      workspaces: i.spaces,
      reason: i.reason,
    }));
  const out: CanRow[] = [];
  if (grouped.length > 0) {
    const kinds = new Map<string, string[]>();
    for (const i of grouped) {
      const k = kindOf(i.permission)!;
      kinds.set(k, [...(kinds.get(k) ?? []), i.permission]);
    }
    const permissions = asOffered(grouped);
    out.push({
      key: KINDS_ROW,
      label: "Records",
      kind: null,
      decisions: false,
      levels: [
        "off",
        ...(grouped.some((i) => isReadOnlyPermission(i.permission))
          ? (["view"] as const)
          : []),
        ...(grouped.some((i) => isWriteTier(i.permission))
          ? (["edit"] as const)
          : []),
      ],
      permissions,
      members: [],
      kinds: [...kinds.entries()].map(([kind, perms]) => ({
        kind,
        label: grantKindLabel(kind),
        permissions: perms,
      })),
    });
  }
  for (const row of groupByObject(asOffered(rest), actsAs)) {
    out.push({ ...row, kinds: [] });
  }
  return out;
}

/** Every permission of a row, its folded members' included. */
const rowPermissions = (row: ConsentObject) =>
  row.permissions.map((p) => p.permission);

/** A row's level, read from the draft: Edit, View, On, or Off. */
export function rowLevel(draft: ConsentDraft, row: ConsentObject): AccessLevel {
  let read = false;
  for (const p of rowPermissions(row)) {
    if (!draft.permissions.has(p)) continue;
    if (row.decisions) return "on";
    if (isWriteTier(p)) return "edit";
    read = true;
  }
  return read ? "view" : "off";
}

/** The permissions a level gives on a row (as `consent-model`'s `givesAt`). */
function gives(level: AccessLevel, permission: string): boolean {
  if (level === "on") return isDecisionPermission(permission);
  if (level === "edit") return !isDecisionPermission(permission);
  if (level === "view") return isReadOnlyPermission(permission);
  return false;
}

/**
 * The level control pressed. Off clears the row; View keeps its reads; Edit
 * gives reads and writes; On gives its decisions. On the F4 row, a kind the
 * person turned off stays off when the level changes between View and Edit.
 */
export function setRowLevel(
  draft: ConsentDraft,
  row: CanRow | ConsentObject,
  level: AccessLevel
): ConsentDraft {
  const next = new Set(draft.permissions);
  const kinds = "kinds" in row ? row.kinds : [];
  const kindOff = (p: string) => {
    if (kinds.length === 0) return false;
    const k = kinds.find((x) => x.permissions.includes(p));
    return (
      !!k &&
      rowLevel(draft, row) !== "off" &&
      !k.permissions.some((q) => draft.permissions.has(q))
    );
  };
  for (const p of rowPermissions(row)) {
    const off = kindOff(p);
    next.delete(p);
    if (gives(level, p) && !off) next.add(p);
  }
  return { ...draft, permissions: next };
}

/** One kind's level on the F4 row: Edit when a write of it is on, View, or Off. */
export function kindLevel(
  draft: ConsentDraft,
  row: CanRow,
  kind: string
): AccessLevel {
  const k = row.kinds.find((x) => x.kind === kind);
  if (!k) return "off";
  const on = k.permissions.filter((p) => draft.permissions.has(p));
  if (on.some(isWriteTier)) return "edit";
  return on.length > 0 ? "view" : "off";
}

/** The levels a kind may take: View when it asked to read it, Edit when to write it. */
export function kindLevels(row: CanRow, kind: string): AccessLevel[] {
  const k = row.kinds.find((x) => x.kind === kind);
  if (!k) return ["off"];
  return [
    "off",
    ...(k.permissions.some((p) => !isWriteTier(p)) ? (["view"] as const) : []),
    ...(k.permissions.some(isWriteTier) ? (["edit"] as const) : []),
  ];
}

/**
 * The kinds that are on hold different levels (some View, some Edit): the
 * row says "Mixed" and no level is selected, so nothing is flattened until
 * the person presses one (an explicit choice for every kind).
 */
export function kindsMixed(draft: ConsentDraft, row: CanRow): boolean {
  const levels = new Set(
    row.kinds
      .map((k) => kindLevel(draft, row, k.kind))
      .filter((l) => l !== "off")
  );
  return levels.size > 1;
}

/** One kind set to a level, inside the expanded F4 row. */
export function setKindLevel(
  draft: ConsentDraft,
  row: CanRow,
  kind: string,
  level: AccessLevel
): ConsentDraft {
  const k = row.kinds.find((x) => x.kind === kind);
  if (!k) return draft;
  const next = new Set(draft.permissions);
  for (const p of k.permissions) {
    next.delete(p);
    if (gives(level, p)) next.add(p);
  }
  return { ...draft, permissions: next };
}

/** How many of the F4 row's kinds are on. */
export function kindsOn(draft: ConsentDraft, row: CanRow): number {
  return row.kinds.filter((k) =>
    k.permissions.some((p) => draft.permissions.has(p))
  ).length;
}

/** One kind of the F4 row turned on or off, at the row's level (View when Off). */
export function toggleKind(
  draft: ConsentDraft,
  row: CanRow,
  kind: string
): ConsentDraft {
  const k = row.kinds.find((x) => x.kind === kind);
  if (!k) return draft;
  const next = new Set(draft.permissions);
  const on = k.permissions.some((p) => draft.permissions.has(p));
  const current = rowLevel(draft, row);
  const level = current === "off" ? (row.levels[1] ?? "off") : current;
  for (const p of k.permissions) {
    next.delete(p);
    if (!on && gives(level, p)) next.add(p);
  }
  return { ...draft, permissions: next };
}

/** "All N kinds it asked for": all on → all off; some or none → all on. */
export function toggleAllKinds(draft: ConsentDraft, row: CanRow): ConsentDraft {
  const all = kindsOn(draft, row) === row.kinds.length;
  if (all) return setRowLevel(draft, row, "off");
  const current = rowLevel(draft, row);
  const level = current === "off" ? (row.levels[1] ?? "off") : current;
  const next = new Set(draft.permissions);
  for (const p of rowPermissions(row)) if (gives(level, p)) next.add(p);
  return { ...draft, permissions: next };
}

/**
 * A vocabulary noun mid-sentence: "Posts" → "posts"; "AI agents" stays. The
 * ONE place a label is lower-cased (never at a call site).
 */
export const midSentence = (noun: string) =>
  /^[A-Z]{2}/.test(noun) ? noun : noun.charAt(0).toLowerCase() + noun.slice(1);

/** A row's name mid-sentence: "records (29 kinds)", "posts", "decide for you". */
function rowNoun(draft: ConsentDraft, row: CanRow): string {
  if (row.key === KINDS_ROW) {
    return consentT()("can.records", { n: kindsOn(draft, row) });
  }
  return midSentence(row.label);
}

/** "A", "A and B", "A, B and C", in the catalog's words for "and". */
export function andList(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")}${consentT()("list.and")}${words[words.length - 1]}`;
}

/**
 * The "It can" line's answer: one entry per level given, in the order View,
 * Edit, On ("View records (29 kinds) and 9 more", "Edit jobs and processes",
 * "On decide for you"). What it also sees is named when it is two things or
 * fewer, counted beyond. Empty when nothing is on.
 */
export function canSummary(
  draft: ConsentDraft,
  rows: readonly CanRow[]
): Array<{ level: Exclude<AccessLevel, "off">; text: string }> {
  const t = consentT();
  const by: Record<Exclude<AccessLevel, "off">, string[]> = {
    view: [],
    edit: [],
    on: [],
  };
  let also: string[] = [];
  for (const row of rows) {
    const level = rowLevel(draft, row);
    if (level === "off") continue;
    if (row.key === ALSO_SEE) {
      also = row.members
        .filter((m) => rowLevel(draft, m) !== "off")
        .map((m) => midSentence(m.label));
      continue;
    }
    by[level].push(rowNoun(draft, row));
  }
  const out: Array<{ level: Exclude<AccessLevel, "off">; text: string }> = [];
  const seen =
    also.length <= 2
      ? [...by.view, ...also]
      : by.view.length > 0
        ? [...by.view, t("can.more", { n: also.length })]
        : [...also.slice(0, 2), t("can.more", { n: also.length - 2 })];
  if (seen.length > 0) out.push({ level: "view", text: andList(seen) });
  if (by.edit.length > 0) out.push({ level: "edit", text: andList(by.edit) });
  if (by.on.length > 0) out.push({ level: "on", text: andList(by.on) });
  return out;
}

/**
 * The decision rows the person left Off, by name: the "It can" line says
 * them ("Not allowed to decide for you"), so a decision it asked for is
 * never silently missing from the summary.
 */
export function decisionsOff(
  draft: ConsentDraft,
  rows: readonly CanRow[]
): string[] {
  return rows
    .filter((r) => r.decisions && rowLevel(draft, r) === "off")
    .map((r) => r.label);
}

/** The draft holds a permission of the write tier (a change or a decision). */
export function needsWritePlace(draft: ConsentDraft): boolean {
  for (const p of draft.permissions) if (isWriteTier(p)) return true;
  return false;
}

/** The rows at Edit or On, by name: what "Pick where" asks about. */
export function writeRows(
  draft: ConsentDraft,
  rows: readonly CanRow[]
): CanRow[] {
  return rows.filter((r) => {
    const l = rowLevel(draft, r);
    return l === "edit" || l === "on";
  });
}

// ─── In / It changes things in: the answers ──────────────────────────────────

/** One place named by a line: a space or a project, never a bare id. */
export interface PlacePart {
  kind: "workspace" | "project";
  id: string;
  name: string;
  /** The pod no longer names it: `name` is already a full phrase. */
  gone?: boolean;
}

/** A place's name, or what to call it when the pod no longer shows it. */
function partOf(
  kind: "workspace" | "project",
  id: string,
  names: Readonly<Record<string, string>>
): PlacePart {
  const t = consentT();
  const known = names[id];
  return known
    ? { kind, id, name: known }
    : {
        kind,
        id,
        name:
          kind === "project" ? t("place.goneProject") : t("place.goneSpace"),
        gone: true,
      };
}

/**
 * THE builder of the "In" answer: every place, or the picked spaces and the
 * picked projects (F3 is a union). `inPhrase` says it; the lines draw it
 * with each name a door.
 */
export function readParts(
  draft: ConsentDraft,
  names: Readonly<Record<string, string>>
): "all" | { spaces: PlacePart[]; projects: "all" | PlacePart[] } {
  if (draft.read.spaces === "all") return "all";
  return {
    spaces: draft.read.spaces.map((id) => partOf("workspace", id, names)),
    projects:
      draft.read.projects === "all"
        ? "all"
        : draft.read.projects.map((id) => partOf("project", id, names)),
  };
}

/** THE builder of the "It changes things in" answer. */
export function writeParts(
  draft: ConsentDraft,
  names: Readonly<Record<string, string>>
): PlacePart[] {
  return [
    ...draft.write.spaces.map((id) => partOf("workspace", id, names)),
    ...draft.write.projects.map((id) => partOf("project", id, names)),
  ];
}

/** A part in words: "Builder", "project Launch v1". */
export function partWords(part: PlacePart): string {
  return part.kind === "project" && !part.gone
    ? consentT()("place.project", { name: part.name })
    : part.name;
}

/**
 * The "In" line's answer in words: every place, or the picked spaces, then
 * "every project" / the picked projects, joined by "or" (F3 is a union).
 * "Nowhere yet" when nothing is picked.
 */
export function inPhrase(
  draft: ConsentDraft,
  names: Readonly<Record<string, string>>
): string {
  const t = consentT();
  const parts = readParts(draft, names);
  if (parts === "all") return t("in.every");
  const groups: string[] = [];
  if (parts.spaces.length > 0)
    groups.push(andList(parts.spaces.map(partWords)));
  if (parts.projects === "all") groups.push(t("in.everyProject"));
  else if (parts.projects.length > 0)
    groups.push(andList(parts.projects.map(partWords)));
  return groups.length === 0 ? t("in.nowhere") : groups.join(t("list.or"));
}

/** The "It changes things in" answer, or null when nothing is picked. */
export function writePhrase(
  draft: ConsentDraft,
  names: Readonly<Record<string, string>>
): string | null {
  const parts = writeParts(draft, names);
  return parts.length === 0 ? null : andList(parts.map(partWords));
}

/** "All spaces" is picked and no project is: the F3 union sentence is moot. */
export function showsUnion(draft: ConsentDraft): boolean {
  if (draft.read.spaces === "all") return false;
  const projects = draft.read.projects;
  return (
    draft.read.spaces.length > 0 && (projects === "all" || projects.length > 0)
  );
}

/**
 * Reads that "All spaces" cannot carry: a read the pod has no pod-wide form
 * of (the offer's `podWide`, the contract's `allSpaces`; else the grammar's
 * own rule) holds only in a space you pick. They are not sent under All
 * (`toAccess`), and the screen names them beside "It can", never silently.
 */
export function notEverywhere(
  draft: ConsentDraft,
  rows: readonly CanRow[],
  offer: ConsentOffer
): string[] {
  if (draft.read.spaces !== "all") return [];
  const everywhere = (p: string) => {
    const item = offer.items.find((i) => i.permission === p);
    return item ? item.podWide : isPodWideReadPermission(p);
  };
  const out: string[] = [];
  for (const p of draft.permissions) {
    if (isWriteTier(p) || everywhere(p)) continue;
    const row = rows
      .flatMap((r): ConsentObject[] => [r, ...r.members])
      .find((r) => r.key !== ALSO_SEE && rowPermissions(r).includes(p));
    const name = row ? midSentence(row.label) : permissionLabel(p);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The live headline: what Allow would give, in one or two short sentences
 * folded like the "It can" line ("Sees records (29 kinds) and 9 more
 * everywhere in your pod. Wants to change jobs (pick where)."). It reads the
 * access Allow SENDS (`toAccess`), so a read not sent under All is not said;
 * a change still asked for with no place picked is always said.
 */
export function draftHeadline(
  draft: ConsentDraft,
  offer: ConsentOffer,
  rows: readonly CanRow[],
  names: Readonly<Record<string, string>>
): string {
  const t = consentT();
  const sent = toAccess(draft, offer);
  const shown = draftOf(sent);
  const summary = canSummary(shown, rows);
  const view = summary.find((s) => s.level === "view");
  const change = summary.filter((s) => s.level !== "view").map((s) => s.text);
  const out: string[] = [];
  if (view) {
    out.push(
      sent.read.spaces === "all"
        ? t("headline.seesEverywhere", { what: view.text })
        : t("headline.sees", {
            what: view.text,
            where: t("place.in", { name: inPhrase(shown, names) }),
          })
    );
  }
  if (change.length > 0) {
    const where = writePhrase(shown, names);
    out.push(
      where
        ? t("headline.changes", { what: andList(change), where })
        : t("headline.changesPick", { what: andList(change) })
    );
  }
  return out.length > 0 ? out.join(" ") : t("headline.nothing");
}

/**
 * Why Allow cannot be pressed yet, said under it, or null. In order: nothing
 * can be given at all; nothing it asked for would be sent (with the right
 * remedy when only reads that hold in picked spaces are on, under All); it
 * changes things and no place is picked (the remedy names the rows to set to
 * View); it reads and no place is picked.
 */
export function draftBlockedReason(
  draft: ConsentDraft,
  offer: ConsentOffer,
  rows: readonly CanRow[]
): string | null {
  const t = consentT();
  if (!offer.items.some(givable)) return t("blocked.noSpace");
  const access = toAccess(draft, offer);
  if (access.permissions.length === 0) {
    const onlyPicked = notEverywhere(draft, rows, offer);
    return onlyPicked.length > 0
      ? t("blocked.onlyPicked", { names: andList(onlyPicked) })
      : t("blocked.nothing");
  }
  const writes = access.permissions.some(isWriteTier);
  if (
    writes &&
    access.write.spaces.length + access.write.projects.length === 0
  ) {
    const names = writeRows(draft, rows).map((r) => r.label);
    const toView = writeRows(draft, rows).every((r) =>
      r.levels.includes("view")
    );
    return names.length > 0 && toView
      ? t("blocked.writeOrView", { names: andList(names) })
      : t("blocked.write");
  }
  const reads = access.permissions.some((p) => !isWriteTier(p));
  const readNowhere =
    access.read.spaces !== "all" &&
    access.read.spaces.length === 0 &&
    access.read.projects !== "all" &&
    access.read.projects.length === 0;
  if (reads && readNowhere) return t("blocked.read");
  return null;
}

// ─── Can't give ──────────────────────────────────────────────────────────────

export interface CantGive {
  permission: string;
  label: string;
  reason: string;
  /** Never given to an app, or given nowhere because no space can hold it. */
  why: "never" | "noSpace";
}

/**
 * What it asked for that cannot be given (design A "Can't grant"): scopes no
 * app is given (`ignoredScopes`), and permissions with no place to give them
 * in. Each with its reason; never a disabled toggle. Only the "no space"
 * ones can be fixed by creating a space (`why`).
 */
export function cantGive(
  offer: ConsentOffer,
  ignoredScopes: readonly string[]
): CantGive[] {
  const t = consentT();
  const out: CantGive[] = [];
  for (const s of ignoredScopes) {
    out.push({
      permission: s,
      label: s === "*" ? FULL_ACCESS_LABEL : s,
      reason: t("cant.ignored"),
      why: "never",
    });
  }
  for (const i of offer.items) {
    if (givable(i)) continue;
    out.push({
      permission: i.permission,
      label: permissionLabel(i.permission),
      reason: isWriteTier(i.permission)
        ? t("cant.noWriteSpace")
        : t("cant.noReadSpace"),
      why: "noSpace",
    });
  }
  return out;
}

// ─── What the connection holds: re-consent and the app page ──────────────────

/** A place as words: "in Builder", "everywhere in your pod", "in project Launch". */
export function wherePhrase(
  pair: AccessPair,
  names: Readonly<Record<string, string>>
): string {
  const t = consentT();
  switch (pair.where.kind) {
    case "pod":
      return t("place.everywhere");
    case "all-projects":
      return t("place.everyProject");
    case "space":
      return t("place.in", {
        name: names[pair.where.id] ?? t("place.goneSpace"),
      });
    case "project":
      return t("place.inProject", {
        name: names[pair.where.id] ?? t("place.goneProject"),
      });
  }
}

/** The connection's current access, read from what it holds. */
export type HeldAccess =
  /** Its pairs ARE a v2 access: the three lines show it. */
  | { kind: "access"; access: AppAccess }
  /**
   * Its pairs do not fit one v2 access (`liftApprovedRequests`): the v2 form
   * the screen proposes, and what changes in it, each a line to confirm.
   */
  | {
      kind: "reconsent";
      proposed: AppAccess;
      widens: AccessPair[];
      narrows: AccessPair[];
    }
  /** Nothing held: a first consent. */
  | { kind: "none" };

/**
 * What a connection holds, from its approved pairs (today's wire). The W3d
 * contract sends `access` and the re-consent payload directly; until then the
 * same pure lift the server runs answers it.
 */
export function heldAccessOf(
  approved: ReadonlyArray<{ permission: string; workspaceId: string | null }>
): HeldAccess {
  if (approved.length === 0) return { kind: "none" };
  const lifted = liftApprovedRequests(approved);
  if ("access" in lifted) return { kind: "access", access: lifted.access };
  return {
    kind: "reconsent",
    proposed: candidateAccess(pairsOfRequests(approved).pairs),
    widens: [...lifted.reconsent.widens],
    narrows: [...lifted.reconsent.narrows],
  };
}

export interface ReconsentChange {
  key: string;
  mark: "wider" | "narrower" | "new";
  /** "Read voice guides", in the vocabulary's words. */
  what: string;
  /** Every place it holds once confirmed: "in Brand and Ecosystem". */
  now: string;
  /** Every place it held: "in Brand", or null for a new ask. */
  was: string | null;
  /** The permission the narrowing door turns off. */
  permission: string;
  /** The door's words: "Keep to the 29 kinds" / "Turn goals off everywhere". */
  narrow: string;
  reason: string | null;
}

/**
 * The re-consent's changes, ONE line per permission (U2): what the v2 form
 * widens says every place it would hold and every place it held ("Read voice
 * guides: now in Brand and Ecosystem (was in Brand)"), with a door that turns
 * that permission off (everywhere, which it says; "Keep to the N kinds" when
 * the F4 kinds still read what it needs); what it narrows is said; what the
 * app asks that the connection never held is a new ask, off until the person
 * turns it on. `held` names what the connection already has (the contract's
 * `current` / `proposed` permissions); else the pairs' permissions.
 */
export function reconsentChanges(
  held: HeldAccess,
  offer: ConsentOffer,
  rows: readonly CanRow[],
  current: ReadonlyArray<{ permission: string; workspaceId: string | null }>,
  heldPermissions?: ReadonlySet<string>
): ReconsentChange[] {
  const t = consentT();
  const names = placeNames(offer);
  const kindsRow = rows.find((r) => r.key === KINDS_ROW);
  // Every place of a permission in ONE phrase: "in Brand and Ecosystem".
  const phraseOf = (pairs: readonly AccessPair[]) => {
    if (pairs.some((p) => p.where.kind === "pod")) return t("place.everywhere");
    const spaces: string[] = [];
    const projects: string[] = [];
    for (const p of pairs) {
      if (p.where.kind === "space")
        spaces.push(names[p.where.id] ?? t("place.goneSpace"));
      else if (p.where.kind === "project")
        projects.push(names[p.where.id] ?? t("place.goneProject"));
    }
    const parts: string[] = [];
    if (spaces.length > 0) parts.push(t("place.in", { name: andList(spaces) }));
    if (projects.length > 0)
      parts.push(t("place.inProject", { name: andList(projects) }));
    if (pairs.some((p) => p.where.kind === "all-projects"))
      parts.push(t("place.everyProject"));
    return andList(parts);
  };
  const wasOf = (permission: string) => {
    const pairs = current.filter((c) => c.permission === permission);
    if (pairs.length === 0) return null;
    if (pairs.some((c) => c.workspaceId === null)) return t("place.everywhere");
    return t("place.in", {
      name: andList(
        pairs.map((c) => names[c.workspaceId ?? ""] ?? t("place.goneSpace"))
      ),
    });
  };
  const objectName = (permission: string) => {
    const row = rows
      .flatMap((r): ConsentObject[] => [r, ...r.members])
      .find(
        (r) =>
          r.key !== ALSO_SEE &&
          r.key !== KINDS_ROW &&
          rowPermissions(r).includes(permission)
      );
    return midSentence(row ? row.label : permissionLabel(permission));
  };
  const out: ReconsentChange[] = [];
  if (held.kind === "reconsent") {
    const proposed = expandAppAccess(held.proposed);
    const widened = [...new Set(held.widens.map((w) => w.permission))];
    for (const permission of widened) {
      const now = proposed.filter((p) => p.permission === permission);
      const coveredByKinds =
        !!kindsRow &&
        kindOf(permission) === null &&
        permission.startsWith("entity.");
      out.push({
        key: `wider:${permission}`,
        mark: "wider",
        what: permissionLabel(permission),
        now: phraseOf(now),
        was: wasOf(permission) ?? t("reconsent.nowhere"),
        permission,
        // Turning it off takes it away everywhere, where it was too: say so.
        narrow:
          kindsRow && coveredByKinds
            ? t("reconsent.keepKinds", { n: kindsRow.kinds.length })
            : t("reconsent.turnOffEverywhere", {
                what: objectName(permission),
              }),
        reason: null,
      });
    }
    const narrowed = [...new Set(held.narrows.map((n) => n.permission))];
    for (const permission of narrowed) {
      const lost = held.narrows.filter((n) => n.permission === permission);
      out.push({
        key: `narrower:${permission}`,
        mark: "narrower",
        what: permissionLabel(permission),
        now: t("reconsent.noLonger", { where: phraseOf(lost) }),
        was: phraseOf(lost),
        permission,
        narrow: "",
        reason: null,
      });
    }
  }
  if (held.kind !== "none") {
    const holds = heldPermissions ?? new Set(current.map((c) => c.permission));
    for (const i of offer.items) {
      if (holds.has(i.permission) || !givable(i)) continue;
      out.push({
        key: `new:${i.permission}`,
        mark: "new",
        what: permissionLabel(i.permission),
        now: "",
        was: null,
        permission: i.permission,
        narrow: "",
        reason: i.reason,
      });
    }
  }
  return out;
}

/**
 * What a re-consent starts with: what the connection holds in its v2 form,
 * within today's offer. A permission it asks for now and never held starts
 * OFF (the pod keeps what the person approved, not what they were asked: a
 * "no" last time looks exactly like a new ask), as today.
 */
export function reconsentDraft(
  held: HeldAccess,
  offer: ConsentOffer,
  opts: { verified?: boolean } = {}
): ConsentDraft {
  if (held.kind === "none") return firstDraft(offer, opts);
  const access = held.kind === "access" ? held.access : held.proposed;
  const draft = draftOf(access);
  const offered = new Set(offer.items.filter(givable).map((i) => i.permission));
  return {
    ...draft,
    permissions: new Set([...draft.permissions].filter((p) => offered.has(p))),
  };
}

/** The new asks of a re-consent turned on or off together (today's switch). */
export function allowNew(
  draft: ConsentDraft,
  changes: readonly ReconsentChange[],
  on: boolean
): ConsentDraft {
  const next = new Set(draft.permissions);
  for (const c of changes) {
    if (c.mark !== "new") continue;
    if (on) next.add(c.permission);
    else next.delete(c.permission);
  }
  return { ...draft, permissions: next };
}

/** Every new ask is on: the switch reads On. */
export function newAllowed(
  draft: ConsentDraft,
  changes: readonly ReconsentChange[]
): boolean {
  const asks = changes.filter((c) => c.mark === "new");
  return (
    asks.length > 0 && asks.every((c) => draft.permissions.has(c.permission))
  );
}

/** Two drafts give the same: the app page's Save is pressable only when not. */
export function sameDraft(a: ConsentDraft, b: ConsentDraft): boolean {
  const sameIds = (x: AccessAllOrIds, y: AccessAllOrIds) =>
    x === "all" || y === "all"
      ? x === y
      : x.length === y.length && x.every((id) => y.includes(id));
  return (
    a.permissions.size === b.permissions.size &&
    [...a.permissions].every((p) => b.permissions.has(p)) &&
    sameIds(a.read.spaces, b.read.spaces) &&
    sameIds(a.read.projects, b.read.projects) &&
    sameIds(a.write.spaces, b.write.spaces) &&
    sameIds(a.write.projects, b.write.projects)
  );
}

// ─── The W3d consent contract (pod document be6caecc, v1.2) ──────────────────
//
// `getOAuthConsentContext().app.access` (and, for the app page,
// `apps.accessOffer`): the asked permissions, the places the person may give,
// what the connection holds now, the re-consent and the short ask, all with
// names. Typed FROM the generated router types (backend#1197), so a change on
// the server is a type error here; `contractOf` still reads it at run time,
// so an older pod (no `access`) keeps today's offer.

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** The consent context's v2 block (`OAuthAppAccessConsent`). */
export type ConsentContract = NonNullable<
  NonNullable<
    RouterOutputs["apiKeys"]["getOAuthConsentContext"]["app"]
  >["access"]
>;
/** A v2 access with names (`NamedAppAccess`). */
export type NamedAppAccess = NonNullable<ConsentContract["current"]>;
export type NamedSpace = NamedAppAccess["write"]["spaces"][number];
export type NamedProject = NamedAppAccess["write"]["projects"][number];
/** Why a connection asks again (`ReconsentView`). */
export type ContractReconsent = NonNullable<ConsentContract["reconsent"]>;
/** The v2 short ask (`OAuthAppAccessAsk`). */
export type ContractAsk = NonNullable<ConsentContract["ask"]>;
/** The app page's `apps.accessOffer` answer: the same blocks, no ask. */
export type AccessOfferView = RouterOutputs["apps"]["accessOffer"];

/** The contract's block on an app, when this pod sends it. */
export function contractOf(
  app: object | null | undefined
): ConsentContract | null {
  const access = (app as { access?: unknown } | null | undefined)?.access;
  if (!access || typeof access !== "object") return null;
  const c = access as Partial<ConsentContract>;
  return c.asked && c.places ? (access as ConsentContract) : null;
}

/**
 * The contract as this model's offer: each asked permission in its tier's
 * places (reads in `places.read`, the rest in `places.write`), pod-wide when
 * `allSpaces`; one the person can give nowhere has no place (can't give).
 * The launch's `space_hint` lists that space first (order only, never sent).
 */
export function offerOfContract(
  c: Pick<ConsentContract, "asked" | "places">,
  spaceHint?: string | null
): ConsentOffer {
  const ordered = (list: readonly NamedSpace[]) => {
    const hinted = spaceHint ? list.find((s) => s.id === spaceHint) : undefined;
    return hinted ? [hinted, ...list.filter((s) => s !== hinted)] : [...list];
  };
  const space = (s: NamedSpace): OfferedSpace => ({
    workspaceId: s.id,
    workspaceName: s.name,
    templateSlug: s.templateSlug,
  });
  const project = (p: NamedProject): OfferedProject => ({
    projectId: p.id,
    projectName: p.name,
    workspaceId: p.workspaceId,
  });
  return {
    items: c.asked.permissions.map((a) => {
      const tier = a.tier === "read" ? c.places.read : c.places.write;
      return {
        permission: a.permission,
        reason: trimmed(a.reason),
        kindGroup: a.kindGroup,
        spaces: a.offerable ? ordered(tier.spaces).map(space) : [],
        projects: a.offerable ? tier.projects.map(project) : [],
        podWide: a.offerable && a.tier === "read" && a.allSpaces,
      };
    }),
    templates: [...c.asked.templates],
    projectsOffered: true,
  };
}

/** A named access as ids (what is sent back). */
export function accessOfNamed(a: NamedAppAccess): AppAccess {
  return {
    version: APP_ACCESS_VERSION,
    permissions: [...a.permissions],
    read: {
      spaces: a.read.spaces === "all" ? "all" : a.read.spaces.map((s) => s.id),
      projects:
        a.read.projects === "all" ? "all" : a.read.projects.map((p) => p.id),
    },
    write: {
      spaces: a.write.spaces.map((s) => s.id),
      projects: a.write.projects.map((p) => p.id),
    },
  };
}

/** The names a named access carries, beside the offer's. */
export function namesOfNamed(
  a: NamedAppAccess | null | undefined
): Record<string, string> {
  const names: Record<string, string> = {};
  if (!a) return names;
  const add = (list: ReadonlyArray<{ id: string; name: string }> | "all") => {
    if (list !== "all") for (const x of list) names[x.id] = x.name;
  };
  add(a.read.spaces);
  add(a.read.projects);
  add(a.write.spaces);
  add(a.write.projects);
  return names;
}

/** What the connection held, as today's pairs (a project place has none). */
export function wasPairs(
  r: ContractReconsent
): Array<{ permission: string; workspaceId: string | null }> {
  return r.was
    .filter((w) => w.place.kind !== "project")
    .map((w) => ({
      permission: w.permission,
      workspaceId: w.place.kind === "pod" ? null : w.place.id,
    }));
}

/**
 * What the contract says the connection holds: its current access, or the
 * re-consent's proposed form with what changes (now / was, from `was`).
 */
export function heldOfContract(
  c: Pick<ConsentContract, "current" | "reconsent">
): HeldAccess {
  if (c.reconsent) {
    const was = wasPairs(c.reconsent);
    const local = heldAccessOf(was);
    return {
      kind: "reconsent",
      proposed: accessOfNamed(c.reconsent.proposed),
      widens: local.kind === "reconsent" ? local.widens : [],
      narrows: local.kind === "reconsent" ? local.narrows : [],
    };
  }
  if (c.current) return { kind: "access", access: accessOfNamed(c.current) };
  return { kind: "none" };
}

/**
 * The draft a contract consent starts with: the re-consent's proposed form,
 * the current access, or a first draft whose write places are the server's
 * `suggestedSpaceIds` (spaces made from a declared template; [] = none), and
 * only for an app Synap checked (an unverified app's templates are its own
 * words).
 */
export function contractDraft(
  c: Pick<ConsentContract, "places" | "current" | "reconsent">,
  offer: ConsentOffer,
  opts: { verified?: boolean } = {}
): ConsentDraft {
  if (c.reconsent) return draftOf(accessOfNamed(c.reconsent.proposed));
  if (c.current) return draftOf(accessOfNamed(c.current));
  const first = firstDraft(offer, opts);
  return {
    ...first,
    write: {
      spaces:
        opts.verified === false ? [] : [...c.places.write.suggestedSpaceIds],
      projects: [],
    },
  };
}

/** What a contract connection already holds, by permission (new asks are the rest). */
export function heldPermissionsOf(
  c: Pick<ConsentContract, "current" | "reconsent">
): Set<string> | undefined {
  const a = c.reconsent?.proposed ?? c.current;
  return a ? new Set(a.permissions) : undefined;
}
