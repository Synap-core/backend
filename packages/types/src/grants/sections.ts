/**
 * The grant editor's SECTIONS — how the subjects a person can grant are
 * grouped, described and counted. Pure: every grant UI (web selector, relay,
 * pod-admin) reads the same sections, so "Records · 3/24" means the same thing
 * on every surface.
 *
 * The rows are DERIVED, never hand-listed per surface:
 *  - one row per catalog subject (`GRANT_SUBJECT_CATALOG`, or an editor's own
 *    catalog such as `AGENT_GRANT_CATALOG`);
 *  - for a kind-qualified subject (`entity`), an "every kind" row plus one row
 *    per kind the pod has (`profiles.list`, passed in by the host), carrying
 *    the pod's own name and description for that kind.
 * A subject no group names falls into "Other", so a new catalog subject is
 * never silently missing from the editor.
 *
 * Words: section titles and row descriptions are product COPY (sentences, not
 * domain values), so they live here. Every noun and verb still comes from the
 * vocabulary door, through `grantSubjectLabel` / `grantKindLabel`.
 */

import {
  GRANT_SUBJECT_CATALOG,
  grantKindLabel,
  grantSubjectLabel,
  isQualifiedGrantSubject,
  type GrantAction,
  type GrantSubjectSpec,
} from "./catalog.js";
import { isGranted, isImpliedByAllKinds, type GrantDraft } from "./draft.js";

export interface GrantSubjectGroup {
  readonly id: string;
  readonly label: string;
  readonly subjects: readonly string[];
}

/** The section order and membership. A subject in none of them → "Other". */
export const GRANT_SUBJECT_GROUPS: readonly GrantSubjectGroup[] = [
  { id: "records", label: "Records", subjects: ["entity"] },
  {
    id: "content",
    label: "Content",
    subjects: ["document", "view", "relation"],
  },
  {
    id: "work",
    label: "Work",
    subjects: [
      "project",
      "session",
      "proposal",
      "playbook",
      "automation",
      "channel",
    ],
  },
  { id: "schema", label: "Schema", subjects: ["profile", "property_def"] },
];

const OTHER_GROUP = { id: "other", label: "Other" } as const;

/** One line per subject: what granting it reaches. */
export const GRANT_SUBJECT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  entity: "Every kind of record, including kinds added later",
  document: "Pages and the written content attached to records",
  view: "Tables, boards, calendars and other saved views",
  relation: "The links between records",
  project: "Projects and what is filed into them",
  session: "Focus sessions, their outputs and progress",
  proposal: "Changes waiting for review",
  playbook: "Reusable step-by-step processes",
  automation: "Rules that run when something happens",
  channel: "Conversations and their messages",
  profile: "Kinds and roles: the shape of your records",
  property_def: "The fields each kind carries",
};

/** A kind the host offers as a row (its profile). */
export interface GrantSectionKind {
  readonly slug: string;
  readonly name?: string;
  readonly description?: string | null;
}

export interface GrantSectionRow {
  /** Stable key: `subject` or `subject.kind`. */
  readonly key: string;
  readonly subject: string;
  /** null = unqualified; `*` = every kind; else a kind slug. */
  readonly kind: string | null;
  readonly label: string;
  readonly description: string;
  readonly actions: readonly GrantAction[];
  /** Actions this row grants (implied ones included). */
  readonly granted: readonly GrantAction[];
}

export interface GrantSection {
  readonly id: string;
  readonly label: string;
  readonly rows: readonly GrantSectionRow[];
  /** Rows granting at least one action. */
  readonly grantedRows: number;
}

export interface BuildGrantSectionsInput {
  readonly draft: GrantDraft;
  readonly catalog?: readonly GrantSubjectSpec[];
  readonly kinds?: readonly GrantSectionKind[];
  /** Case-insensitive filter on a row's label and description. */
  readonly query?: string;
  /** Actions always granted to this holder (an agent's reads). */
  readonly alwaysAllowed?: readonly GrantAction[];
}

/**
 * The sections an editor renders, in order, empty sections dropped. Counts
 * are taken over the FILTERED rows, so a search shows "how much of what I
 * am looking at is granted".
 */
export function buildGrantSections({
  draft,
  catalog = GRANT_SUBJECT_CATALOG,
  kinds = [],
  query = "",
  alwaysAllowed = [],
}: BuildGrantSectionsInput): GrantSection[] {
  const q = query.trim().toLowerCase();
  const matches = (r: { label: string; description: string }) =>
    !q ||
    r.label.toLowerCase().includes(q) ||
    r.description.toLowerCase().includes(q);

  const rowFor = (
    spec: GrantSubjectSpec,
    kind: string | null,
    label: string,
    description: string
  ): GrantSectionRow => ({
    key: kind && kind !== "*" ? `${spec.subject}.${kind}` : spec.subject,
    subject: spec.subject,
    kind,
    label,
    description,
    actions: spec.actions,
    granted: spec.actions.filter(
      (action) =>
        alwaysAllowed.includes(action) ||
        isGranted(draft, { subject: spec.subject, kind, action }) ||
        isImpliedByAllKinds(draft, { subject: spec.subject, kind, action })
    ),
  });

  const rowsOf = (spec: GrantSubjectSpec): GrantSectionRow[] => {
    const own = GRANT_SUBJECT_DESCRIPTIONS[spec.subject] ?? "";
    if (!isQualifiedGrantSubject(spec.subject))
      return [rowFor(spec, null, grantSubjectLabel(spec.subject), own)];
    const kindRows = [...kinds]
      .map((k) =>
        rowFor(
          spec,
          k.slug,
          grantKindLabel(k.slug, k.name),
          k.description?.trim() ?? ""
        )
      )
      .sort((a, b) => a.label.localeCompare(b.label));
    return [
      rowFor(spec, "*", grantSubjectLabel(spec.subject), own),
      ...kindRows,
    ];
  };

  const grouped = new Set(GRANT_SUBJECT_GROUPS.flatMap((g) => g.subjects));
  const groups = [
    ...GRANT_SUBJECT_GROUPS,
    {
      ...OTHER_GROUP,
      subjects: catalog.map((s) => s.subject).filter((s) => !grouped.has(s)),
    },
  ];

  return groups
    .map((g) => {
      const rows = g.subjects
        .map((subject) => catalog.find((s) => s.subject === subject))
        .filter((s): s is GrantSubjectSpec => !!s)
        .flatMap(rowsOf)
        .filter(matches);
      return {
        id: g.id,
        label: g.label,
        rows,
        grantedRows: rows.filter((r) => r.granted.length > 0).length,
      };
    })
    .filter((s) => s.rows.length > 0);
}
