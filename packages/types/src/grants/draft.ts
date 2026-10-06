/**
 * GrantDraft — the value a grant selector edits, and the pure operations on it.
 *
 * A draft is exactly the mint door's wire shape (`apiKeys.create` `grant` +
 * `expiresInDays`), so the selector never translates: what you see is what is
 * minted. Every op returns a NEW draft and normalises it, so two drafts that
 * grant the same thing are spelled the same (that is what lets a preset — a
 * future ROLE — be recognised by value).
 *
 * TWO RULES THE OPS KEEP (each has a test that fails without it):
 *  1. Normalising never WIDENS a catalog cell's coverage, and never produces
 *     `*` — full access is only ever chosen explicitly.
 *  2. Turning a cell OFF removes exactly that cell. When it was covered by a
 *     broader pattern (`entity`, `entity.*.read`, `*`), that pattern is broken
 *     into the catalog cells it covered, minus this one. That is a NARROWING:
 *     the broken pattern's coverage outside the catalog (gate verbs such as
 *     `entity.note.merge`, other subjects under `*`) is dropped, never kept.
 *
 * The one sanctioned widening: ticking EVERY catalog action of a subject (or of
 * one kind) compacts to the subject pattern (`entity.knowledge`), which in the
 * grammar means "every action", gate verbs included. That is the design
 * decision of W1 ("`entity.knowledge` = every action on knowledge"), and the
 * summary renders it as "All", not as four verbs.
 */

import {
  assertPermissions,
  DEFAULT_KEY_TTL_DAYS,
  GRANT_ACTIONS,
  parsePermission,
  patternMatches,
  type GrantRequest,
} from "./grammar.js";
import {
  GRANT_SUBJECT_CATALOG,
  grantSubjectSpec,
  isQualifiedGrantSubject,
  type GrantAction,
} from "./catalog.js";

/** The longest lifetime the mint door accepts (`ExpiresInDaysSchema`). */
export const MAX_KEY_TTL_DAYS = 36_500;

export interface GrantDraft {
  /** Permission patterns, `<subject>[.<kind>].<action>`. */
  readonly permissions: readonly string[];
  /** null/undefined/[] = any workspace the person can reach. */
  readonly workspaceIds?: readonly string[] | null;
  /** null/undefined/[] = no project narrowing. */
  readonly projectIds?: readonly string[] | null;
  /** null/undefined/[] = no object pinning. */
  readonly entityIds?: readonly string[] | null;
  /** undefined → DEFAULT_KEY_TTL_DAYS; a number → that many days; null → never. */
  readonly expiresInDays?: number | null;
  /** What the person calls it ("Portfolio site"); a stored grant may have none. */
  readonly label?: string | null;
}

/** One checkbox: a subject × action, and a kind for a qualified subject. */
export interface GrantCell {
  readonly subject: string;
  /** Qualified subjects only: a kind slug, or null/undefined/`*` = every kind. */
  readonly kind?: string | null;
  readonly action: GrantAction;
}

/** What a toggle needs to know about the pod: its kinds, for splitting `*`. */
export interface GrantContext {
  /** Kind slugs offered as rows (a wildcard is split into these). */
  readonly kinds: readonly string[];
}

export const EMPTY_GRANT_DRAFT: GrantDraft = { permissions: [] };

// ── atoms ───────────────────────────────────────────────────────────────────

/** One catalog cell in canonical form. kind: null = unqualified, `*` = any. */
interface Atom {
  subject: string;
  kind: string | null;
  action: string;
}

function cellAtom(cell: GrantCell): Atom {
  const qualified = isQualifiedGrantSubject(cell.subject);
  return {
    subject: cell.subject,
    kind: qualified ? cell.kind || "*" : null,
    action: cell.action,
  };
}

function atomRequest(a: Atom): GrantRequest {
  return {
    subject: a.subject,
    qualifier: a.kind && a.kind !== "*" ? a.kind : null,
    action: a.action,
  };
}

function atomPattern(a: Atom): string {
  return a.kind === null
    ? `${a.subject}.${a.action}`
    : `${a.subject}.${a.kind}.${a.action}`;
}

function tryParse(pattern: string): string[] | null {
  try {
    return parsePermission(pattern);
  } catch {
    // An invalid pattern grants nothing; validateGrantDraft reports it.
    return null;
  }
}

function safeMatches(pattern: string, req: GrantRequest): boolean {
  return tryParse(pattern) !== null && patternMatches(pattern, req);
}

/** The catalog cells a parsed pattern covers, at the pattern's own generality. */
function expandToAtoms(segs: string[]): Atom[] {
  const specs =
    segs[0] === "*"
      ? GRANT_SUBJECT_CATALOG
      : GRANT_SUBJECT_CATALOG.filter((s) => s.subject === segs[0]);
  const out: Atom[] = [];
  for (const spec of specs) {
    const qualified = isQualifiedGrantSubject(spec.subject);
    const kind = qualified ? (segs[0] === "*" ? "*" : (segs[1] ?? "*")) : null;
    const actionSeg = segs[0] === "*" ? "*" : segs[qualified ? 2 : 1];
    for (const action of spec.actions) {
      if (actionSeg === undefined || actionSeg === "*" || actionSeg === action)
        out.push({ subject: spec.subject, kind, action });
    }
  }
  return out;
}

// ── reading a draft ────────────────────────────────────────────────────────

/** Is this cell granted (by any pattern, however broad)? */
export function isGranted(draft: GrantDraft, cell: GrantCell): boolean {
  const req = atomRequest(cellAtom(cell));
  return draft.permissions.some((p) => safeMatches(p, req));
}

/** Is the whole draft `*` (explicit full access)? */
export function isFullAccess(draft: GrantDraft): boolean {
  return draft.permissions.some((p) => p.trim() === "*");
}

/**
 * Is the cell granted only because a BROADER row grants it — a kind row under
 * an "every kind" grant? The UI renders such a cell as implied (checked,
 * locked) so a person unticks the row that actually holds it.
 */
export function isImpliedByAllKinds(
  draft: GrantDraft,
  cell: GrantCell
): boolean {
  if (!isQualifiedGrantSubject(cell.subject) || !cell.kind || cell.kind === "*")
    return false;
  return isGranted(draft, { ...cell, kind: "*" });
}

// ── normalising ────────────────────────────────────────────────────────────

/** Does pattern j cover everything pattern k covers? (both canonical) */
function subsumes(j: string, k: string): boolean {
  const js = j.split(".");
  const ks = k.split(".");
  if (js[0] === "*") return true;
  if (js.length > ks.length) return false;
  return js.every((seg, i) => seg === "*" || seg === ks[i]);
}

function catalogRank(p: string): [number, number, string, number] {
  if (p === "*") return [-1, 0, "", 0];
  const segs = p.split(".");
  const si = GRANT_SUBJECT_CATALOG.findIndex((s) => s.subject === segs[0]);
  const qualified = isQualifiedGrantSubject(segs[0]);
  const kind = qualified ? (segs[1] ?? "") : "";
  const action = qualified ? segs[2] : segs[1];
  const ai =
    action === undefined
      ? -1
      : (GRANT_ACTIONS as readonly string[]).indexOf(action);
  return [
    si === -1 ? GRANT_SUBJECT_CATALOG.length : si,
    kind === "*" || kind === "" ? 0 : 1,
    si === -1 ? p : kind,
    ai,
  ];
}

function compareRank(a: string, b: string): number {
  const ra = catalogRank(a);
  const rb = catalogRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return 0;
}

/**
 * The canonical spelling of a permission list: the governance spelling
 * normalised (`entity.read` → `entity.*.read`), duplicates and patterns
 * covered by a broader one dropped, a subject (or kind) with every catalog
 * action compacted to its subject pattern, catalog order. Invalid patterns are
 * kept verbatim at the end — validation reports them; normalising never hides
 * one.
 */
export function normalizeGrantPermissions(
  permissions: readonly string[]
): string[] {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const raw of permissions) {
    const segs = tryParse(raw);
    if (segs) valid.add(segs.join("."));
    else if (!invalid.includes(raw.trim())) invalid.push(raw.trim());
  }

  // Compact: every catalog action granted on (subject, kind) → the subject
  // pattern. Coverage is computed on the full set, so one pass is complete.
  const list = [...valid];
  const granted = (a: Atom) =>
    list.some((p) => patternMatches(p, atomRequest(a)));
  for (const spec of GRANT_SUBJECT_CATALOG) {
    if (isQualifiedGrantSubject(spec.subject)) {
      const kinds = new Set<string>(["*"]);
      for (const p of list) {
        const s = p.split(".");
        if (s[0] === spec.subject && s[1]) kinds.add(s[1]);
      }
      for (const kind of kinds) {
        if (
          spec.actions.every((action) =>
            granted({ subject: spec.subject, kind, action })
          )
        )
          valid.add(kind === "*" ? spec.subject : `${spec.subject}.${kind}`);
      }
    } else if (
      spec.actions.every((action) =>
        granted({ subject: spec.subject, kind: null, action })
      )
    ) {
      valid.add(spec.subject);
    }
  }

  const all = [...valid];
  const kept = all.filter((k) => !all.some((j) => j !== k && subsumes(j, k)));
  return [...kept.sort(compareRank), ...invalid];
}

function withPermissions(draft: GrantDraft, permissions: string[]): GrantDraft {
  return { ...draft, permissions: normalizeGrantPermissions(permissions) };
}

/** The same draft, permissions normalised. */
export function normalizeGrantDraft(draft: GrantDraft): GrantDraft {
  return withPermissions(draft, [...draft.permissions]);
}

// ── editing ────────────────────────────────────────────────────────────────

/** Turn one cell on or off (see rule 2 in the header for OFF). */
export function toggleGrant(
  draft: GrantDraft,
  cell: GrantCell,
  on: boolean,
  ctx: GrantContext
): GrantDraft {
  const target = cellAtom(cell);
  const req = atomRequest(target);
  if (on) {
    if (isGranted(draft, cell)) return draft;
    return withPermissions(draft, [...draft.permissions, atomPattern(target)]);
  }
  const out: string[] = [];
  for (const p of draft.permissions) {
    const segs = tryParse(p);
    if (!segs || !patternMatches(p, req)) {
      out.push(p);
      continue;
    }
    // Break the covering pattern into its catalog cells, minus the target.
    for (const atom of expandToAtoms(segs)) {
      const covers =
        atom.subject === target.subject &&
        atom.action === target.action &&
        (atom.kind === target.kind || atom.kind === "*");
      if (!covers) {
        out.push(atomPattern(atom));
      } else if (atom.kind === "*" && target.kind !== "*") {
        for (const kind of ctx.kinds)
          if (kind !== target.kind) out.push(atomPattern({ ...atom, kind }));
      }
    }
  }
  return withPermissions(draft, out);
}

/**
 * Set exactly which actions a subject row (or one kind of it) grants — the
 * "all / none" row control. Actions outside the subject's catalog are ignored.
 */
export function setRowActions(
  draft: GrantDraft,
  row: { subject: string; kind?: string | null },
  actions: readonly GrantAction[],
  ctx: GrantContext
): GrantDraft {
  const spec = grantSubjectSpec(row.subject);
  if (!spec) return draft;
  let next = draft;
  for (const action of spec.actions) {
    next = toggleGrant(next, { ...row, action }, actions.includes(action), ctx);
  }
  return next;
}

/** Replace the permission list (a preset / role, or "Full access"). */
export function setGrantPermissions(
  draft: GrantDraft,
  permissions: readonly string[]
): GrantDraft {
  return withPermissions(draft, [...permissions]);
}

const emptyToNull = (ids: readonly string[] | null | undefined) =>
  ids && ids.length > 0 ? [...ids] : null;

/** Narrow to these workspaces; [] / null = any workspace. */
export function setGrantWorkspaces(
  draft: GrantDraft,
  ids: readonly string[] | null
): GrantDraft {
  return { ...draft, workspaceIds: emptyToNull(ids) };
}

/** Narrow to these projects; [] / null = no project narrowing. */
export function setGrantProjects(
  draft: GrantDraft,
  ids: readonly string[] | null
): GrantDraft {
  return { ...draft, projectIds: emptyToNull(ids) };
}

/** undefined → the default (90 days); a number → days; null → never. */
export function setGrantLifetime(
  draft: GrantDraft,
  expiresInDays: number | null | undefined
): GrantDraft {
  const next = { ...draft };
  if (expiresInDays === undefined)
    delete (next as { expiresInDays?: unknown }).expiresInDays;
  else
    (next as { expiresInDays?: number | null }).expiresInDays = expiresInDays;
  return next;
}

// ── lifetime ───────────────────────────────────────────────────────────────

export type GrantLifetime =
  | {
      readonly kind: "days";
      readonly days: number;
      readonly isDefault: boolean;
    }
  | { readonly kind: "never" };

/** The lifetime a mint of this draft gets (mirrors `resolveKeyExpiry`). */
export function grantLifetime(draft: GrantDraft): GrantLifetime {
  if (draft.expiresInDays === null) return { kind: "never" };
  if (draft.expiresInDays === undefined)
    return { kind: "days", days: DEFAULT_KEY_TTL_DAYS, isDefault: true };
  return { kind: "days", days: draft.expiresInDays, isDefault: false };
}

// ── validating ─────────────────────────────────────────────────────────────

export type GrantProblem =
  | { readonly code: "no-permissions" }
  | {
      readonly code: "invalid-permission";
      readonly pattern: string;
      readonly message: string;
    }
  | { readonly code: "invalid-lifetime"; readonly days: number };

export type GrantValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly GrantProblem[] };

/** Everything the mint door would refuse, before it is asked. */
export function validateGrantDraft(draft: GrantDraft): GrantValidation {
  const problems: GrantProblem[] = [];
  try {
    assertPermissions(draft.permissions);
  } catch {
    // assertPermissions stops at the first problem; list every one.
    if (draft.permissions.length === 0)
      problems.push({ code: "no-permissions" });
    for (const pattern of draft.permissions) {
      try {
        parsePermission(pattern);
      } catch (e) {
        problems.push({
          code: "invalid-permission",
          pattern,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  const d = draft.expiresInDays;
  if (
    typeof d === "number" &&
    (!Number.isInteger(d) || d < 1 || d > MAX_KEY_TTL_DAYS)
  )
    problems.push({ code: "invalid-lifetime", days: d });
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

// ── the mint wire shape ────────────────────────────────────────────────────

export interface GrantMintInput {
  grant: {
    permissions: string[];
    workspaceIds?: string[];
    projectIds?: string[];
    entityIds?: string[];
    label?: string;
    /** The stored role it was built from (lineage) — see `grantRoleLineage`. */
    roleId?: string;
  };
  /** Omitted → 90 days; null → never. */
  expiresInDays?: number | null;
}

/**
 * The `grant` + `expiresInDays` arguments of `apiKeys.create` /
 * `createForWorkspace`. The door's sets are optional, never nullable, so an
 * absent narrowing is omitted rather than sent as null.
 */
export function toGrantMintInput(draft: GrantDraft): GrantMintInput {
  const grant: GrantMintInput["grant"] = {
    permissions: normalizeGrantPermissions(draft.permissions),
  };
  const ws = emptyToNull(draft.workspaceIds);
  const pr = emptyToNull(draft.projectIds);
  const en = emptyToNull(draft.entityIds);
  if (ws) grant.workspaceIds = ws;
  if (pr) grant.projectIds = pr;
  if (en) grant.entityIds = en;
  if (draft.label?.trim()) grant.label = draft.label.trim();
  return draft.expiresInDays === undefined
    ? { grant }
    : { grant, expiresInDays: draft.expiresInDays };
}
