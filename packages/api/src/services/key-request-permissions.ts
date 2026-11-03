/**
 * A key request BY PERMISSIONS (founder, 2 Nov 2026: agents request the exact
 * key they need). An agent names the grant patterns it needs instead of a
 * template; the list is then the request's CEILING exactly as a template is
 * (`key-requests.ts`): the person may narrow it, never widen it, and the key
 * is minted only when the computer collects it after approval.
 *
 * This file decides what such a list may hold, before anything is filed:
 *  - every pattern parses in the grant grammar (`parsePermission`);
 *  - its SUBJECT is one the pod grants on: a catalog subject, a qualified one,
 *    a subject the read hook narrows (`GRANT_READ_SPECS`) or the grant subject
 *    of a governed write door (`GOVERNED_WRITE_DOORS` through
 *    `grantRequestKeys`, the fold every refusing layer uses). A typo
 *    (`entitty.read`) is a 400 that names it, never a key that grants nothing;
 *  - its VERB is read/create/update/delete or `*`, or a gate verb a door of
 *    that subject names (`entity` also takes GRANT_GATE_ACTIONS, and the
 *    powerful actions the New key page offers count);
 *  - `*` is refused: full access has its own template, with its shorter life.
 * The KIND of a qualified subject (`entity.<kind>`) is the pod's own profile
 * slug and is not checked: a kind the pod does not have grants nothing.
 *
 * Lifetime (a choice the founder may override): 90 days by default, at most
 * 365, never "never". Uses: `hub` by default, any the built-in templates use.
 */

import {
  GOVERNED_WRITE_DOORS,
  grantRequestKeys,
} from "@synap/governance-policy";
import {
  DEFAULT_KEY_TTL_DAYS,
  GRANT_ACTIONS,
  GRANT_GATE_ACTIONS,
  GRANT_SUBJECT_CATALOG,
  KEY_POWERFUL_ACTIONS,
  KEY_TEMPLATES,
  MAX_GRANT_PERMISSIONS,
  QUALIFIED_GRANT_SUBJECTS,
  accessFamily,
  isQualifiedGrantSubject,
  keyTemplate,
  normalizeGrantPermissions,
  parsePermission,
  setFamilyLevel,
  type GrantDraft,
  type KeyCeiling,
} from "@synap-core/types/grants";
import { GRANT_READ_SPECS } from "../access/grant-read.js";

/**
 * The `template_id` a request by permissions is stored with: it names no
 * template (built-in ids are slugs, a person's roles are uuids), so the row
 * says what was asked and no template lookup ever matches it.
 */
export const CUSTOM_KEY_REQUEST_TEMPLATE_ID = "custom-permissions";
/** The key's name when the request names none. */
export const CUSTOM_KEY_REQUEST_NAME = "Requested permissions";
export const CUSTOM_KEY_REQUEST_DEFAULT_DAYS = DEFAULT_KEY_TTL_DAYS;
export const CUSTOM_KEY_REQUEST_MAX_DAYS = 365;
/** Where a requested key may be used: what the built-in templates allow. */
export const CUSTOM_KEY_REQUEST_USES: readonly string[] = [
  ...new Set(KEY_TEMPLATES.flatMap((t) => t.uses ?? [])),
];
const DEFAULT_USES = ["hub"];

const CRUD = GRANT_ACTIONS as readonly string[];

let vocabulary: ReadonlyMap<string, ReadonlySet<string>> | null = null;

/** Every subject the pod grants on → the gate verbs (not CRUD) it names. */
export function grantVocabulary(): ReadonlyMap<string, ReadonlySet<string>> {
  if (vocabulary) return vocabulary;
  const out = new Map<string, Set<string>>();
  const add = (subject: string, verb?: string) => {
    const verbs = out.get(subject) ?? new Set<string>();
    if (verb && !CRUD.includes(verb)) verbs.add(verb);
    out.set(subject, verbs);
  };
  for (const s of GRANT_SUBJECT_CATALOG) add(s.subject);
  for (const s of QUALIFIED_GRANT_SUBJECTS) add(s);
  for (const spec of GRANT_READ_SPECS.values()) add(spec.subject);
  for (const door of Object.keys(GOVERNED_WRITE_DOORS)) {
    const at = door.indexOf("/");
    for (const key of grantRequestKeys(door.slice(0, at), door.slice(at + 1)))
      add(key.subject, key.action);
  }
  for (const verb of GRANT_GATE_ACTIONS) add("entity", verb);
  for (const a of KEY_POWERFUL_ACTIONS) add(a.subject, a.verb);
  vocabulary = out;
  return out;
}

const fullAccessDays = () => keyTemplate("full-access")?.grant.expiresInDays;

/** What is wrong with a requested permission list, one sentence each ([] = nothing). */
export function requestedPermissionProblems(
  permissions: readonly string[]
): string[] {
  if (permissions.length === 0)
    return ["Name at least one permission, such as entity.note.read."];
  const problems: string[] = [];
  const known = grantVocabulary();
  for (const raw of permissions) {
    let segs: string[];
    try {
      segs = parsePermission(raw);
    } catch (e) {
      problems.push(
        `"${raw}" is not a permission: ${e instanceof Error ? e.message : String(e)}.`
      );
      continue;
    }
    const subject = segs[0]!;
    if (subject === "*") {
      const days = fullAccessDays();
      problems.push(
        `"*" is full access. Ask for the full-access template instead (synap keys request full-access)${days ? `: it lasts at most ${days} days` : ""}.`
      );
      continue;
    }
    const verbs = known.get(subject);
    if (!verbs) {
      problems.push(
        `"${raw}": "${subject}" is not something a key can be granted.`
      );
      continue;
    }
    const verb = segs[isQualifiedGrantSubject(subject) ? 2 : 1];
    if (
      verb !== undefined &&
      verb !== "*" &&
      !CRUD.includes(verb) &&
      !verbs.has(verb)
    )
      problems.push(`"${raw}": "${verb}" is not an action on ${subject}.`);
  }
  const count = normalizeGrantPermissions(permissions).length;
  if (count > MAX_GRANT_PERMISSIONS)
    problems.push(
      `A key holds at most ${MAX_GRANT_PERMISSIONS} permissions; this asks for ${count}.`
    );
  return problems;
}

/**
 * The ceiling a request by permissions asks for: the list (canonical), pinned
 * to the space or project named, for its lifetime and uses. `problems` says
 * why it cannot be filed.
 */
export function ceilingFromPermissions(
  permissions: readonly string[],
  opts: {
    expiresInDays?: number | null;
    workspaceId?: string;
    projectId?: string;
    uses?: readonly string[];
  }
): { ceiling: KeyCeiling & { grant: GrantDraft }; problems: string[] } {
  const asked = permissions.map((p) => p.trim());
  const problems = requestedPermissionProblems(asked);

  const uses = opts.uses?.length ? [...new Set(opts.uses)] : [...DEFAULT_USES];
  for (const use of uses)
    if (!CUSTOM_KEY_REQUEST_USES.includes(use))
      problems.push(
        `"${use}" is not a place a requested key can be used: pick from ${CUSTOM_KEY_REQUEST_USES.join(", ")}.`
      );

  const days =
    opts.expiresInDays === undefined
      ? CUSTOM_KEY_REQUEST_DEFAULT_DAYS
      : opts.expiresInDays;
  if (days === null || days < 1 || days > CUSTOM_KEY_REQUEST_MAX_DAYS)
    problems.push(
      `A key asked for by permissions lasts 1 to ${CUSTOM_KEY_REQUEST_MAX_DAYS} days (default ${CUSTOM_KEY_REQUEST_DEFAULT_DAYS}), never forever.`
    );

  let granted = normalizeGrantPermissions(asked);
  if (opts.projectId)
    // At a project a key posts no activity (answer 26, finding 8809cc21),
    // exactly as a template asked at a project (`ceilingFromTemplate`).
    granted = [
      ...setFamilyLevel(
        { permissions: granted },
        accessFamily("activity"),
        "off"
      ).permissions,
    ];
  if (problems.length === 0 && granted.length === 0)
    problems.push(
      "These permissions can do nothing at a project: a project key posts no activity. Ask at a space, or for the whole pod."
    );

  const grant: GrantDraft = {
    permissions: granted,
    ...(opts.workspaceId ? { workspaceIds: [opts.workspaceId] } : {}),
    ...(opts.projectId ? { projectIds: [opts.projectId] } : {}),
    expiresInDays: days ?? CUSTOM_KEY_REQUEST_DEFAULT_DAYS,
  };
  return { ceiling: { grant, uses }, problems };
}
