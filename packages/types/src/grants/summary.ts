/**
 * summarizeGrant — the ONE read-only rendering model of a grant: structured
 * rows (for marks: a chip per action, "All" when a subject pattern grants
 * every action) plus a short sentence for places with room for one line
 * (a connection list row, a consent screen subtitle).
 *
 * Words come from the vocabulary door through `./catalog.ts`; nothing here
 * names a subject or an action by hand.
 */

import {
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "../vocabulary/index.js";
import { GRANT_ACTIONS, parsePermission } from "./grammar.js";
import {
  GRANT_SUBJECT_CATALOG,
  grantActionLabel,
  grantKindLabel,
  grantSubjectLabel,
  grantSubjectSpec,
  isQualifiedGrantSubject,
  type GrantAction,
} from "./catalog.js";
import {
  grantLifetime,
  isFullAccess,
  isGranted,
  normalizeGrantPermissions,
  type GrantDraft,
  type GrantLifetime,
} from "./draft.js";

export interface GrantSummaryRow {
  /** Stable React key: `subject` or `subject.kind`. */
  readonly key: string;
  readonly subject: string;
  /** null = an unqualified subject; `*` = every kind; else a kind slug. */
  readonly kind: string | null;
  readonly label: string;
  /** Catalog actions granted (a kind row lists only what "every kind" does not). */
  readonly actions: readonly GrantAction[];
  /** A subject/kind pattern grants EVERY action on it, gate verbs included. */
  readonly all: boolean;
}

export interface GrantSummary {
  /** `*` — explicit full access. Rows are empty then. */
  readonly full: boolean;
  readonly rows: readonly GrantSummaryRow[];
  /** Valid patterns the catalog has no row for (`vault.redeem`), verbatim. */
  readonly other: readonly string[];
  /** Patterns the mint door would refuse, verbatim. */
  readonly invalid: readonly string[];
  /** null = any workspace. */
  readonly workspaceIds: readonly string[] | null;
  /** null = no project narrowing. */
  readonly projectIds: readonly string[] | null;
  /** null = no object pinning; else how many objects it is pinned to. */
  readonly entityCount: number | null;
  readonly lifetime: GrantLifetime;
  /** One line: "Read Entities, Documents; Create Notes · 1 Space · 90 days". */
  readonly sentence: string;
}

export interface SummarizeGrantOptions {
  /** The pod's own names for kinds (slug → name), when it has them. */
  readonly kindNames?: Readonly<Record<string, string>>;
}

const nonEmpty = (ids: readonly string[] | null | undefined) =>
  ids && ids.length > 0 ? ids : null;

function isCatalogPattern(p: string): boolean {
  const segs = parsePermission(p);
  if (segs[0] === "*") return true;
  const spec = grantSubjectSpec(segs[0]);
  if (!spec) return false;
  const action = segs[isQualifiedGrantSubject(segs[0]) ? 2 : 1];
  return (
    action === undefined ||
    action === "*" ||
    (spec.actions as readonly string[]).includes(action)
  );
}

function count(n: number, kind: string): string {
  return `${n} ${n === 1 ? resolveObjectNoun(kind) : resolveObjectNounPlural(kind)}`;
}

export function summarizeGrant(
  draft: GrantDraft,
  opts: SummarizeGrantOptions = {}
): GrantSummary {
  const normalized = normalizeGrantPermissions(draft.permissions);
  const invalid: string[] = [];
  const valid: string[] = [];
  for (const p of normalized) {
    try {
      parsePermission(p);
      valid.push(p);
    } catch {
      invalid.push(p);
    }
  }
  const d: GrantDraft = { ...draft, permissions: valid };
  const full = isFullAccess(d);
  const has = (p: string) => valid.includes(p);

  const rows: GrantSummaryRow[] = [];
  if (!full) {
    for (const spec of GRANT_SUBJECT_CATALOG) {
      const { subject } = spec;
      if (!isQualifiedGrantSubject(subject)) {
        const actions = spec.actions.filter((action) => isGranted(d, { subject, action }));
        if (actions.length > 0)
          rows.push({ key: subject, subject, kind: null, label: grantSubjectLabel(subject), actions, all: has(subject) });
        continue;
      }
      const every = spec.actions.filter((action) => isGranted(d, { subject, kind: "*", action }));
      if (every.length > 0)
        rows.push({ key: subject, subject, kind: "*", label: grantSubjectLabel(subject), actions: every, all: has(subject) });
      const kinds = new Set<string>();
      for (const p of valid) {
        const s = p.split(".");
        if (s[0] === subject && s[1] && s[1] !== "*") kinds.add(s[1]);
      }
      for (const kind of kinds) {
        const actions = spec.actions.filter(
          (action) => !every.includes(action) && isGranted(d, { subject, kind, action })
        );
        if (actions.length > 0)
          rows.push({
            key: `${subject}.${kind}`,
            subject,
            kind,
            label: grantKindLabel(kind, opts.kindNames?.[kind]),
            actions,
            all: has(`${subject}.${kind}`),
          });
      }
    }
  }
  const other = full ? [] : valid.filter((p) => !isCatalogPattern(p));

  const workspaceIds = nonEmpty(draft.workspaceIds);
  const projectIds = nonEmpty(draft.projectIds);
  const entityIds = nonEmpty(draft.entityIds);
  const lifetime = grantLifetime(draft);

  let what: string;
  if (full) what = "Full access";
  else if (rows.length === 0 && other.length === 0) what = "No access";
  else {
    const parts: string[] = [];
    for (const action of GRANT_ACTIONS) {
      const labels = rows.filter((r) => r.all || r.actions.includes(action)).map((r) => r.label);
      if (labels.length > 0) parts.push(`${grantActionLabel(action)} ${labels.join(", ")}`);
    }
    if (other.length > 0) parts.push(`+${other.length} more`);
    what = parts.join("; ");
  }
  const where: string[] = [];
  if (workspaceIds) where.push(count(workspaceIds.length, "workspace"));
  if (projectIds) where.push(count(projectIds.length, "project"));
  if (entityIds) where.push(count(entityIds.length, "entity"));
  const when = lifetime.kind === "never" ? "Never expires" : `${lifetime.days} days`;

  return {
    full,
    rows,
    other,
    invalid,
    workspaceIds,
    projectIds,
    entityCount: entityIds ? entityIds.length : null,
    lifetime,
    sentence: [what, ...where, when].join(" · "),
  };
}
