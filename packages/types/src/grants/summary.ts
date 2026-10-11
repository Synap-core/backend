/**
 * summarizeGrant — the ONE read-only rendering model of a grant: structured
 * rows (for marks: a chip per action) plus a short sentence for places with
 * room for one line (a connection list row, a consent screen subtitle).
 *
 * A BARE subject pattern (`proposal`, `entity.note`) grants read, create,
 * update and delete — never a gate verb (grammar.ts) — so its row reads
 * "Read, create, update and delete Proposals" even where the catalog offers
 * fewer checkboxes. A gate verb is granted only when named (`proposal.approve`)
 * and reads as its own verb: "Approve Proposals", "Merge Notes". Only `*`
 * reads "Full access, approving included".
 *
 * Words come from the vocabulary door through `./catalog.ts`; nothing here
 * names a subject or an action by hand.
 */

import {
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveStatusLabel,
} from "../vocabulary/index.js";
import { GRANT_ACTIONS, parsePermission } from "./grammar.js";
import {
  GRANT_SUBJECT_CATALOG,
  grantActionLabel,
  grantKindLabel,
  grantSubjectLabel,
  isQualifiedGrantSubject,
  type GrantAction,
  type GrantSubjectSpec,
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
  /** The bare subject/kind pattern: read, create, update and delete it. */
  readonly all: boolean;
  /**
   * `all` rows only: what that means, in words — "Read, create, update and
   * delete". null when the row grants only the actions it lists.
   */
  readonly everything: string | null;
  /** Gate verbs this row's patterns NAME (`proposal.approve` → `approve`). */
  readonly gates: readonly string[];
}

export interface GrantSummary {
  /** `*` — explicit full access, approving included. Rows are empty then. */
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
  /** The draft's lifetime — `never` too when `expiresAt` is null. */
  readonly lifetime: GrantLifetime;
  /**
   * What it may do: "Read Entities, Documents; Create Notes; Approve
   * Proposals" / "Full access, approving included".
   */
  readonly what: string;
  /** Narrowing, one part each: "1 Space", "2 Projects". Empty = anywhere. */
  readonly where: readonly string[];
  /**
   * When it stops working: the key's real expiry when `expiresAt` was given
   * ("Until 12 Jan 2027" / "Never expires" / "Expired"), else the draft's
   * lifetime ("90 days" / "Never expires").
   */
  readonly when: string;
  /** `expiresAt` was given and has passed. */
  readonly expired: boolean;
  /** One line: what · where · when. */
  readonly sentence: string;
}

export interface SummarizeGrantOptions {
  /** The pod's own names for kinds (slug → name), when it has them. */
  readonly kindNames?: Readonly<Record<string, string>>;
  /**
   * The subjects the holder can be granted (default GRANT_SUBJECT_CATALOG;
   * agents: AGENT_GRANT_CATALOG), so each gets a named row, not "+1 more".
   */
  readonly catalog?: readonly GrantSubjectSpec[];
  /**
   * Actions the holder can never be refused (an agent reads what its person
   * reads, `AGENT_ALWAYS_ALLOWED`). The sentence says them once — "Read only",
   * "Read everything; Create Notes" — instead of "No access".
   */
  readonly alwaysAllowed?: readonly GrantAction[];
  /**
   * An EXISTING key's expiry (`apiKeys.expiresAt`): null = never, a date =
   * that date. Omitted → the draft's lifetime (a key not minted yet).
   */
  readonly expiresAt?: Date | string | null;
}

/** The sentence for `*`: the one pattern that approves without naming it. */
export const GRANT_FULL_ACCESS_SENTENCE = "Full access, approving included";

/** "Read, create, update and delete" — verbs from the vocabulary door. */
function actionList(actions: readonly string[]): string {
  const words = actions.map((a, i) =>
    i === 0 ? grantActionLabel(a) : grantActionLabel(a).toLowerCase()
  );
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
    : (words[0] ?? "");
}

const isCrud = (action: string) =>
  (GRANT_ACTIONS as readonly string[]).includes(action);

/** The action segment of a parsed pattern (undefined = bare). */
function actionOf(segs: readonly string[]): string | undefined {
  return segs[isQualifiedGrantSubject(segs[0]) ? 2 : 1];
}

/** Is this a gate verb a pattern names (not CRUD, not a wildcard)? */
const isGateVerb = (action: string | undefined): action is string =>
  action !== undefined && action !== "*" && !isCrud(action);

const UNTIL_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function expiryWhen(expiresAt: Date | string | null): {
  when: string;
  expired: boolean;
} {
  if (expiresAt === null) return { when: "Never expires", expired: false };
  const at = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  if (Number.isNaN(at.getTime()))
    return { when: "Expiry unknown", expired: false };
  if (at.getTime() <= Date.now())
    return { when: resolveStatusLabel("expired"), expired: true };
  return { when: `Until ${UNTIL_FORMAT.format(at)}`, expired: false };
}

const nonEmpty = (ids: readonly string[] | null | undefined) =>
  ids && ids.length > 0 ? ids : null;

function isCatalogPattern(
  p: string,
  catalog: readonly GrantSubjectSpec[]
): boolean {
  const segs = parsePermission(p);
  if (segs[0] === "*") return true;
  const spec = catalog.find((s) => s.subject === segs[0]);
  if (!spec) return false;
  const action = actionOf(segs);
  return (
    action === undefined ||
    action === "*" ||
    isGateVerb(action) ||
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
  const catalog = opts.catalog ?? GRANT_SUBJECT_CATALOG;
  const alwaysAllowed = opts.alwaysAllowed ?? [];

  const parsed = valid.map((p) => parsePermission(p));
  /** Gate verbs named by patterns on exactly this subject (+ kind slot). */
  const gatesFor = (subject: string, kind: string | null) => {
    const out: string[] = [];
    for (const segs of parsed) {
      const verb = actionOf(segs);
      if (segs[0] !== subject || !isGateVerb(verb)) continue;
      if (kind !== null && segs[1] !== kind) continue;
      if (!out.includes(verb)) out.push(verb);
    }
    return out;
  };
  const allText = actionList(GRANT_ACTIONS);
  const rows: GrantSummaryRow[] = [];
  const pushRow = (
    row: Omit<GrantSummaryRow, "everything" | "gates">,
    gates: string[]
  ) => {
    if (row.actions.length > 0 || row.all || gates.length > 0)
      rows.push({ ...row, everything: row.all ? allText : null, gates });
  };
  if (!full) {
    for (const spec of catalog) {
      const { subject } = spec;
      if (!isQualifiedGrantSubject(subject)) {
        pushRow(
          {
            key: subject,
            subject,
            kind: null,
            label: grantSubjectLabel(subject),
            actions: spec.actions.filter((action) =>
              isGranted(d, { subject, action })
            ),
            all: has(subject),
          },
          gatesFor(subject, null)
        );
        continue;
      }
      const every = spec.actions.filter((action) =>
        isGranted(d, { subject, kind: "*", action })
      );
      pushRow(
        {
          key: subject,
          subject,
          kind: "*",
          label: grantSubjectLabel(subject),
          actions: every,
          all: has(subject),
        },
        gatesFor(subject, "*")
      );
      const kinds = new Set<string>();
      for (const s of parsed)
        if (s[0] === subject && s[1] && s[1] !== "*") kinds.add(s[1]);
      for (const kind of kinds) {
        const pattern = `${subject}.${kind}`;
        pushRow(
          {
            key: pattern,
            subject,
            kind,
            label: grantKindLabel(kind, opts.kindNames?.[kind]),
            actions: spec.actions.filter(
              (action) =>
                !every.includes(action) &&
                isGranted(d, { subject, kind, action })
            ),
            all: has(pattern),
          },
          gatesFor(subject, kind)
        );
      }
    }
  }
  const other = full ? [] : valid.filter((p) => !isCatalogPattern(p, catalog));

  const workspaceIds = nonEmpty(draft.workspaceIds);
  const projectIds = nonEmpty(draft.projectIds);
  const entityIds = nonEmpty(draft.entityIds);
  const lifetime: GrantLifetime =
    opts.expiresAt === null ? { kind: "never" } : grantLifetime(draft);

  let what: string;
  if (full) what = GRANT_FULL_ACCESS_SENTENCE;
  else {
    const bare = actionList(
      GRANT_ACTIONS.filter((a) => !alwaysAllowed.includes(a))
    );
    const parts = bare
      ? rows.filter((r) => r.all).map((r) => `${bare} ${r.label}`)
      : [];
    for (const action of GRANT_ACTIONS) {
      if (alwaysAllowed.includes(action)) continue;
      const labels = rows
        .filter((r) => !r.all && r.actions.includes(action))
        .map((r) => r.label);
      if (labels.length > 0)
        parts.push(`${grantActionLabel(action)} ${labels.join(", ")}`);
    }
    const verbs: string[] = [];
    for (const r of rows)
      for (const g of r.gates) if (!verbs.includes(g)) verbs.push(g);
    for (const verb of verbs) {
      const labels = rows
        .filter((r) => r.gates.includes(verb))
        .map((r) => r.label);
      parts.push(`${grantActionLabel(verb)} ${labels.join(", ")}`);
    }
    if (other.length > 0) parts.push(`+${other.length} more`);
    const always = alwaysAllowed.map(grantActionLabel).join(", ");
    if (always)
      what =
        parts.length > 0
          ? [`${always} everything`, ...parts].join("; ")
          : `${always} only`;
    else what = parts.length > 0 ? parts.join("; ") : "No access";
  }
  const where: string[] = [];
  if (workspaceIds) where.push(count(workspaceIds.length, "workspace"));
  if (projectIds) where.push(count(projectIds.length, "project"));
  if (entityIds) where.push(count(entityIds.length, "entity"));
  const { when, expired } =
    opts.expiresAt !== undefined
      ? expiryWhen(opts.expiresAt)
      : {
          when:
            lifetime.kind === "never"
              ? "Never expires"
              : `${lifetime.days} days`,
          expired: false,
        };

  return {
    full,
    rows,
    other,
    invalid,
    workspaceIds,
    projectIds,
    entityCount: entityIds ? entityIds.length : null,
    lifetime,
    what,
    where,
    when,
    expired,
    sentence: [what, ...where, when].join(" · "),
  };
}

/**
 * What a key may touch, as a key list reads it (`apiKeys.list` /
 * `listForWorkspace` → `access` + `grants`):
 *  - `ungranted` — it never had a grant: it may touch NOTHING (deny by
 *                  default, P5 — every mint attaches one, and 0318 backfilled
 *                  the keys minted before);
 *  - `granted`   — `grants` holds every live grant (a key holds a SET);
 *  - `ended`     — it had grants and none is live: it may touch NOTHING.
 */
export type KeyAccess = "ungranted" | "granted" | "ended";

/** One live grant on the key-list wire. `expiresAt` null = never. */
export interface KeyAccessGrant extends GrantDraft {
  readonly expiresAt: Date | string | null;
}

export interface KeyAccessLine {
  /** What the person called this grant, when they did. */
  readonly label: string | null;
  readonly summary: GrantSummary;
}

export interface KeyAccessDescription {
  readonly access: KeyAccess;
  /** A live `*` grant. Mark as danger. */
  readonly full: boolean;
  /** `ended` or `ungranted`: the key may touch nothing. */
  readonly ended: boolean;
  /** `granted` only: one per live grant, in wire order. Empty otherwise. */
  readonly lines: readonly KeyAccessLine[];
  /** One line for a row: the fixed wording, or each grant's sentence. */
  readonly sentence: string;
}

/** The ONE wording of the two states that are not a grant. */
export const KEY_ACCESS_UNGRANTED_SENTENCE =
  "Can touch nothing: it was never given access";
export const KEY_ACCESS_ENDED_SENTENCE = "Can touch nothing: its access ended";

export function describeKeyAccess(
  key: {
    readonly access: KeyAccess;
    readonly grants: readonly KeyAccessGrant[];
  },
  opts: Pick<SummarizeGrantOptions, "kindNames"> = {}
): KeyAccessDescription {
  if (key.access === "ungranted")
    return {
      access: key.access,
      full: false,
      ended: true,
      lines: [],
      sentence: KEY_ACCESS_UNGRANTED_SENTENCE,
    };
  if (key.access === "ended")
    return {
      access: key.access,
      full: false,
      ended: true,
      lines: [],
      sentence: KEY_ACCESS_ENDED_SENTENCE,
    };
  const lines = key.grants.map((g) => ({
    label: g.label?.trim() || null,
    summary: summarizeGrant(g, {
      kindNames: opts.kindNames,
      expiresAt: g.expiresAt,
    }),
  }));
  return {
    access: key.access,
    full: lines.some((l) => l.summary.full),
    ended: false,
    lines,
    sentence: lines
      .map((l) =>
        l.label ? `${l.label}: ${l.summary.sentence}` : l.summary.sentence
      )
      .join(" | "),
  };
}
