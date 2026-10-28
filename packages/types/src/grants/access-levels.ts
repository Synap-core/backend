/**
 * Access FAMILIES at one level each — the object-first way a person reads and
 * sets what a credential may do (founder, 2026-10-23, the app consent page;
 * key pages plan 447800fe §5.1, decision 68d37853 answers 24 and 26).
 *
 *   Records   Off · View · Edit         (entity)
 *   Content   Off · View · Edit         (document, view, relation)
 *   Work      Off · View · Edit         (project, session, proposal, …)
 *   Activity  Off · View · Post         (event; Post can be limited to families)
 *   Decide    Off · On                  (approve, merge, archive, purge)
 *
 * The families ARE `GRANT_SUBJECT_GROUPS` (`./sections.ts`), kept to the
 * subjects a key can be given (`GRANT_SUBJECT_CATALOG`); Decide is the gate
 * verbs a key holds only by name (`KEY_POWERFUL_ACTIONS`). "Edit" gives every
 * action the catalog offers on a subject, delete included (answer 24: the
 * review then carries a "Can delete" mark, `describeKey`). Kinds, subjects
 * and activity families sit one level deeper: the cell ops of `./draft.ts`
 * edit them, and `familyAccess` says when a family holds only some of them.
 *
 * Words: family names are the sections' labels, level words are product copy
 * beside the levels. Pure.
 */

import { GRANT_ACTIONS, parsePermission } from "./grammar.js";
import {
  GRANT_SUBJECT_CATALOG,
  isQualifiedGrantSubject,
  type GrantAction,
  type GrantSubjectSpec,
} from "./catalog.js";
import {
  isFullAccess,
  isGranted,
  normalizeGrantPermissions,
  type GrantDraft,
} from "./draft.js";
import { GRANT_SUBJECT_GROUPS } from "./sections.js";
import { KEY_POWERFUL_ACTIONS } from "./key-draft.js";
import { allowedQualifiers } from "./grammar.js";

/** A family's one level. `post` is Activity's write; `on` is Decide's. */
export type AccessLevel = "off" | "view" | "edit" | "post" | "on";

/** The words on a level's segment. */
export const LEVEL_WORDS: Readonly<Record<AccessLevel, string>> = {
  off: "Off",
  view: "View",
  edit: "Edit",
  post: "Post",
  on: "On",
};

export type AccessFamilyId =
  "records" | "content" | "work" | "activity" | "decide";

export interface AccessFamily {
  readonly id: AccessFamilyId;
  readonly label: string;
  /** The catalog subjects it sets (Decide: the subjects of its verbs). */
  readonly subjects: readonly string[];
  /** Its levels, lowest first. */
  readonly levels: readonly AccessLevel[];
}

/** Where a key acts (step 1 of the New key page, `./key-steps.ts`). */
export type KeyScope = "pod" | "space" | "project";

const LEVELED_GROUPS = ["records", "content", "work", "activity"] as const;

/**
 * The families, in order. Derived from the sections and the catalog: a
 * subject added to a group joins its family by existing.
 */
export const ACCESS_FAMILIES: readonly AccessFamily[] = [
  ...LEVELED_GROUPS.map((id): AccessFamily => {
    const group = GRANT_SUBJECT_GROUPS.find((g) => g.id === id)!;
    return {
      id,
      label: group.label,
      subjects: group.subjects.filter((s) =>
        GRANT_SUBJECT_CATALOG.some((c) => c.subject === s)
      ),
      levels:
        id === "activity" ? ["off", "view", "post"] : ["off", "view", "edit"],
    };
  }),
  {
    id: "decide",
    label: "Decide",
    subjects: [...new Set(KEY_POWERFUL_ACTIONS.map((a) => a.subject))],
    levels: ["off", "on"],
  },
];

export function accessFamily(id: AccessFamilyId): AccessFamily {
  return ACCESS_FAMILIES.find((f) => f.id === id)!;
}

/**
 * The families a key offers at a scope. A project-scoped key gets no Activity
 * (answer 26): an observation carries no project, so a project-limited key
 * could never post one (finding 8809cc21).
 */
export function accessFamiliesForScope(
  scope: KeyScope
): readonly AccessFamily[] {
  return scope === "project"
    ? ACCESS_FAMILIES.filter((f) => f.id !== "activity")
    : ACCESS_FAMILIES;
}

const specOf = (subject: string): GrantSubjectSpec | undefined =>
  GRANT_SUBJECT_CATALOG.find((s) => s.subject === subject);

/** The catalog cells a level gives on one subject. */
function cellsAt(
  subject: string,
  level: AccessLevel
): { subject: string; action: GrantAction }[] {
  const spec = specOf(subject);
  if (!spec) return [];
  const actions =
    level === "view"
      ? spec.actions.filter((a) => a === "read")
      : level === "post"
        ? spec.actions.filter((a) => a === "create")
        : level === "edit"
          ? spec.actions
          : [];
  return actions.map((action) => ({ subject, action }));
}

function pattern(cell: { subject: string; action: string }): string {
  return isQualifiedGrantSubject(cell.subject)
    ? `${cell.subject}.*.${cell.action}`
    : `${cell.subject}.${cell.action}`;
}

/** The family's level, and whether it holds only some of that level. */
export interface FamilyAccess {
  readonly level: AccessLevel;
  /**
   * Some subjects, kinds or activity families of the family are below the
   * level ("Only some…"). Full access is never partial.
   */
  readonly partial: boolean;
}

const decidePatterns = KEY_POWERFUL_ACTIONS.map((a) => a.pattern);

/** Does the draft hold this gate verb anywhere (by a pattern naming it)? */
function holdsVerb(draft: GrantDraft, verb: string): boolean {
  return draft.permissions.some((p) => {
    try {
      const segs = parsePermission(p);
      return segs[segs.length - 1] === verb && segs.length > 1;
    } catch {
      return false;
    }
  });
}

/** Does any pattern on this subject reach some (not every) qualifier? */
function narrowedOn(draft: GrantDraft, subject: string, action: string) {
  if (!isQualifiedGrantSubject(subject)) return false;
  try {
    const q = allowedQualifiers(draft, subject, action);
    return q !== "all" && q.length > 0;
  } catch {
    return false;
  }
}

export function familyAccess(
  draft: GrantDraft,
  family: AccessFamily
): FamilyAccess {
  if (isFullAccess(draft))
    return { level: family.levels[family.levels.length - 1]!, partial: false };
  if (family.id === "decide") {
    const held = KEY_POWERFUL_ACTIONS.filter((a) => holdsVerb(draft, a.verb));
    if (held.length === 0) return { level: "off", partial: false };
    return {
      level: "on",
      partial: !KEY_POWERFUL_ACTIONS.every((a) =>
        draft.permissions.includes(a.pattern)
      ),
    };
  }
  // The highest level any cell reaches, then: does every cell of that level
  // hold on every qualifier?
  for (const level of [...family.levels].reverse()) {
    if (level === "off") break;
    const cells = family.subjects.flatMap((s) => cellsAt(s, level));
    const full = cells.filter((c) => isGranted(draft, { ...c, kind: "*" }));
    const some = cells.filter(
      (c) =>
        isGranted(draft, { ...c, kind: "*" }) ||
        narrowedOn(draft, c.subject, c.action)
    );
    // A level is reached by its own writes, not by a read it shares with View.
    const own = some.filter((c) => level === "view" || c.action !== "read");
    if (own.length === 0) continue;
    return { level, partial: full.length < cells.length };
  }
  return { level: "off", partial: false };
}

/** Is a pattern one this family sets (a CRUD or bare pattern on its subjects)? */
function ownedBy(family: AccessFamily, p: string): boolean {
  let segs: string[];
  try {
    segs = parsePermission(p);
  } catch {
    return false;
  }
  if (family.id === "decide")
    return KEY_POWERFUL_ACTIONS.some(
      (a) => segs[0] === a.subject && segs[segs.length - 1] === a.verb
    );
  if (!family.subjects.includes(segs[0]!)) return false;
  const action = segs[isQualifiedGrantSubject(segs[0]!) ? 2 : 1];
  return (
    action === undefined ||
    action === "*" ||
    (GRANT_ACTIONS as readonly string[]).includes(action)
  );
}

/**
 * Set one family to a level: every pattern the family sets is replaced by the
 * level's cells on every subject (every kind, every activity family). Other
 * families are untouched. From full access, `*` is broken into every family
 * at its highest level first: a NARROWING, never a widening.
 */
export function setFamilyLevel(
  draft: GrantDraft,
  family: AccessFamily,
  level: AccessLevel
): GrantDraft {
  let base = draft.permissions.filter((p) => p.trim() !== "*");
  if (isFullAccess(draft))
    for (const f of ACCESS_FAMILIES)
      if (f.id !== family.id) base = [...base, ...patternsAt(f, top(f))];
  const kept = base.filter((p) => !ownedBy(family, p));
  return {
    ...draft,
    permissions: normalizeGrantPermissions([
      ...kept,
      ...patternsAt(family, level),
    ]),
  };
}

const top = (f: AccessFamily): AccessLevel => f.levels[f.levels.length - 1]!;

function patternsAt(family: AccessFamily, level: AccessLevel): string[] {
  if (!family.levels.includes(level) || level === "off") return [];
  if (family.id === "decide") return [...decidePatterns];
  return family.subjects.flatMap((s) => cellsAt(s, level)).map(pattern);
}

/**
 * The activity families a draft may post: `"all"`, a list, or [] (it posts
 * nothing).
 */
export function activityFamilies(draft: GrantDraft): "all" | string[] {
  return allowedQualifiers(draft, "event", "create");
}

/**
 * Limit posting to these activity families (`null` = every family). Reading
 * activity is left as it is; a draft that posts nothing starts posting.
 */
export function setActivityFamilies(
  draft: GrantDraft,
  families: readonly string[] | null
): GrantDraft {
  // From full access, break `*` first (every family at its top level).
  const base = isFullAccess(draft)
    ? setFamilyLevel(draft, accessFamily("activity"), "post").permissions
    : draft.permissions;
  const kept: string[] = [];
  for (const p of base) {
    let segs: string[];
    try {
      segs = parsePermission(p);
    } catch {
      kept.push(p);
      continue;
    }
    const action = segs[2];
    if (
      segs[0] !== "event" ||
      (action !== undefined && action !== "*" && action !== "create")
    ) {
      kept.push(p);
      continue;
    }
    // A bare `event` / `event.*` also reads: keep its read.
    if (action !== "create") kept.push(`event.${segs[1] ?? "*"}.read`);
  }
  const added =
    families === null
      ? ["event.create"]
      : families.map((f) => `event.${f}.create`);
  return {
    ...draft,
    permissions: normalizeGrantPermissions([...kept, ...added]),
  };
}
