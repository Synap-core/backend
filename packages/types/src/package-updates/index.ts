/**
 * Package updates — the ONE contract for "what would updating an installed
 * package do, field by field, and what did it do".
 *
 * Every field of an installed package has three values: the catalog's when it
 * was installed (`base`), the catalog's now (`desired`) and the pod's own
 * (`live`). The pod compares them with ONE comparator (`threeWayMergeFields`,
 * `@synap/api` `services/capabilities/market-source.ts`) and names the result
 * with one of four states. Every surface (pod admin, the CLI, Relay, MCP) reads
 * the state from the pod's plan and draws it with `PACKAGE_FIELD_STATE_LABELS`
 * (`@synap-core/types/vocabulary`): no surface compares values itself.
 *
 * Shared by the pod's doors (Hub REST `/package-updates`, tRPC
 * `packageUpdates.*`) and their readers. Pure: zod and data, no I/O.
 */

import { z } from "zod";

/**
 * What the comparison says about one field:
 *   updates — the catalog changed it and the pod did not: it takes the
 *             catalog's value (on its own at the next start, or now on apply);
 *   yours   — the pod changed it and the catalog did not: nothing to decide;
 *   both    — both changed it, to different values: a person chooses;
 *   same    — nothing differs, or the pod's edit equals the catalog's value.
 */
export const PACKAGE_FIELD_STATES = [
  "updates",
  "yours",
  "both",
  "same",
] as const;
export type PackageFieldState = (typeof PACKAGE_FIELD_STATES)[number];

/**
 * What an update needs from a person, the group it is listed under:
 *   consent — it would change existing records (a space update's data change);
 *   choice  — at least one field changed on both sides;
 *   review  — only catalog changes: it applies on its own, and can be looked at;
 *   nothing — the catalog moved, but every field is the same or the pod's own.
 * Ordered most to least urgent; `derivePackageUpdateNeeds` is the one rule.
 */
export const PACKAGE_UPDATE_NEEDS = [
  "consent",
  "choice",
  "review",
  "nothing",
] as const;
export type PackageUpdateNeeds = (typeof PACKAGE_UPDATE_NEEDS)[number];

/** How many fields of a package are in each state. */
export type PackageFieldCounts = Record<PackageFieldState, number>;

/** The kinds of installed row a plan compares field by field. */
export type PackageUpdateRowKind = "view" | "skill" | "automation";

// ─── THE rule: does an installed package have an update? ────────────────────

/**
 * Does the catalog hold a newer version of a package than the one the pod
 * last converged to? THE one rule, for every installed kind (workspace,
 * overlay pack, capability, view, skill, automation) and every surface (pod
 * admin's Updates, the CLI's `market update`, template health, MCP).
 *
 * A version is the Control Plane's CONTENT HASH of the published definition
 * (`h-<12 hex>`: `definitionVersion`, or `h-` + `capabilityContentHash` for a
 * capability, minted once at publish), stamped on the pod only when its
 * reconcile converged. So two content-hash versions that differ are an
 * update. A rare hand-authored semver is an update only when the catalog's is
 * strictly newer (a downgrade is never offered). Null-safe: no stamp, or no
 * catalog version, is "not known to have an update" (`false`) — a caller that
 * must tell "not compared" apart reads `PackageStanding.hasUpdate`, which is
 * `null` then.
 */
export function packageHasUpdate(
  installed: string | null | undefined,
  latest: string | null | undefined
): boolean {
  if (!installed || !latest || installed === latest) return false;
  if (installed.startsWith("h-") || latest.startsWith("h-")) return true;
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * A capability's stamp is the FULL content hash (`metadata.contentHash`); the
 * catalog's version of it is `h-` + its first 12 characters. Put a stamp in
 * version form before `packageHasUpdate` compares it. A value already in
 * version form passes through.
 */
export function contentHashVersion(
  hash: string | null | undefined
): string | null {
  if (!hash) return null;
  return hash.startsWith("h-") ? hash : `h-${hash.slice(0, 12)}`;
}

/** Every kind of installed package the standing covers. */
export const INSTALLED_PACKAGE_KINDS = [
  "workspace",
  "capability",
  "view",
  "skill",
  "automation",
] as const;
export type InstalledPackageKind = (typeof INSTALLED_PACKAGE_KINDS)[number];

/**
 * How an update of a package is decided and applied:
 *   field   — row by row, field by field (`threeWayMergeFields`): view, skill,
 *             automation. The plan lists every field with its state.
 *   package — as a whole, through the kind's own template door (a space's
 *             template apply, a capability's reconcile), which adds what the
 *             new version brings and keeps the pod's edits. The plan has no
 *             field rows.
 */
export const PACKAGE_UPDATE_COMPARED_BY = ["field", "package"] as const;
export type PackageUpdateComparedBy =
  (typeof PACKAGE_UPDATE_COMPARED_BY)[number];

/** Which kinds are updated as a whole. */
export function packageUpdateComparedBy(kind: string): PackageUpdateComparedBy {
  return kind === "workspace" || kind === "capability" ? "package" : "field";
}

/**
 * One installed package and its verdict under `packageHasUpdate`: one entry
 * per package (slug + kind), whatever number of rows it installed.
 */
export interface PackageStanding {
  slug: string;
  kind: InstalledPackageKind;
  name: string;
  /** The version the pod last converged to; null = never stamped. */
  installedVersion: string | null;
  /** The catalog's version now; null = not in the pod's copy of the catalog. */
  latestVersion: string | null;
  /**
   * true / false = compared by `packageHasUpdate`. null = NOT compared (no
   * stamp, no catalog version, the catalog unreadable): `reason` says why.
   * Never a defaulted false.
   */
  hasUpdate: boolean | null;
  reason?: string;
}

/** One row of `GET /package-updates` / `packageUpdates.list`. */
export interface PackageUpdateSummary {
  slug: string;
  /** The catalog kind of the package (`workspace`, `capability`, `skill`, …). */
  kind: string;
  /** Field by field, or as a whole package (`packageUpdateComparedBy`). */
  comparedBy: PackageUpdateComparedBy;
  name: string;
  /** The version the pod's rows last converged to; null when never recorded. */
  installedVersion: string | null;
  latestVersion: string | null;
  counts: PackageFieldCounts;
  /** Records the update would change (space updates only; 0 otherwise). */
  dataChanges: number;
  needs: PackageUpdateNeeds;
  /** The pod path that opens the review page (`/open/update/<slug>`). */
  reviewUrl: string;
}

/**
 * `GET /package-updates` / `packageUpdates.list`: every installed package
 * whose catalog version moved, and every one whose catalog could not be read
 * (named with the reason, never folded into "nothing waiting").
 */
export interface PackageUpdateList {
  updates: PackageUpdateSummary[];
  unreadable: Array<{
    slug: string;
    kind: string;
    name: string;
    reason: string;
  }>;
  /**
   * Every installed package with its verdict (`packageHasUpdate`), the ones
   * with no update included: what a reader lists as "up to date" or "can't
   * check" reads it here instead of comparing versions itself.
   */
  installed: PackageStanding[];
}

/** One pending change to existing records a space update would run. */
export interface PackageDataChange {
  /** The op key `acceptDataChanges` names. */
  id: string;
  /** One plain sentence. */
  sentence: string;
  /** How many records it changes; null when the count failed (never 0). */
  affected: number | null;
  /** Never run by an update: an operator step. */
  destructive: boolean;
  /**
   * What changes, drawn as before → after (finding 4e4b2858). Absent when the
   * op has no from → to shape, or its dry run failed: `sentence` then says it.
   */
  preview?: DataChangePreview;
}

/**
 * A name the pod shows for a kind slug, a field key or a stored value: its
 * label (the profile's display name, the property def's label, the option's
 * label), else the raw token. `key` is always the raw token.
 */
export interface DataChangeLabel {
  key: string;
  label: string;
}

/** A kind's name, with its plural for counts ("31 posts"). */
export interface DataChangeKindLabel extends DataChangeLabel {
  plural: string;
}

/** A capped list of record titles (the pod sends at most 25), and how many more. */
export interface DataChangeSamples {
  titles: string[];
  more: number;
}

/** One side of a change: the kind, what on it is selected, how many. */
export interface DataChangeSide {
  kind: DataChangeKindLabel;
  /** The status the records sit at, or the field the change reads or writes. */
  detail: { as: "status" | "field"; label: DataChangeLabel } | null;
  count: number;
}

/**
 * Records the change looks at and leaves as they are, grouped by why.
 * `fieldsSet`: they already hold a value under each of `fields` (a post
 * already dated, in a series and a campaign stays a post).
 */
export interface DataChangeKeptGroup {
  reason: "fieldsSet";
  fields: DataChangeLabel[];
  count: number;
  samples: DataChangeSamples;
}

/** The shapes a preview draws; each has its own words on every surface. */
export const DATA_CHANGE_PREVIEW_KINDS = [
  "rekind",
  "renameField",
  "renameKind",
  "translateValues",
] as const;
export type DataChangePreviewKind = (typeof DATA_CHANGE_PREVIEW_KINDS)[number];

/**
 * One data change as before → after. `from.count` records change (the
 * engine's own dry-run count); `kept.count` more are looked at and left as
 * they are, so `from.count + kept.count` is everything the change looked at.
 */
export interface DataChangePreview {
  change: DataChangePreviewKind;
  from: DataChangeSide;
  to: DataChangeSide;
  /** Titles of the records that change. */
  samples: DataChangeSamples;
  /** translateValues only: each old value, the new one, and how many hold it. */
  values?: Array<{
    from: DataChangeLabel;
    to: DataChangeLabel;
    count: number;
  }>;
  kept: { count: number; groups: DataChangeKeptGroup[] } | null;
}

/** One compared field of one installed row. */
export interface PackageUpdateField {
  /** The row field name (`body`, `description`, `flowDefinition`, …). */
  key: string;
  /** Its words for a person (`resolvePackageFieldLabel`). */
  label: string;
  state: PackageFieldState;
  /** The catalog's value when installed (or last decided). */
  base: unknown;
  /** The catalog's value now. */
  desired: unknown;
  /** The pod's value now. */
  live: unknown;
  /**
   * `both` text fields only: the line-level 3-way merge of the two edits, or
   * null when they overlap (D2: "Combine both" is offered only without an
   * overlap). Absent for every other field.
   */
  merged?: string | null;
  /** `both` text fields only: the two edits touch the same lines. */
  overlap?: boolean;
}

/** `GET /package-updates/:slug` / `packageUpdates.get`. */
export interface PackageUpdatePlan {
  slug: string;
  kind: string;
  /** `package`: no field rows; the update applies as a whole (see the type). */
  comparedBy: PackageUpdateComparedBy;
  name: string;
  installedVersion: string | null;
  latestVersion: string | null;
  /** The catalog's change notes since the installed version, when it has any. */
  notes?: string[];
  rows: Array<{
    rowKind: PackageUpdateRowKind;
    rowId: string;
    name: string;
    fields: PackageUpdateField[];
  }>;
  /**
   * A space update's changes to existing records (the conversion engine's
   * pending ops, as `/packages/preflight` reports them). The person agrees by
   * sending each consentable item's `id` in `acceptDataChanges`. A
   * `destructive` item is never run by an update: it is an operator step on
   * pod admin (`needsPodAdmin`).
   */
  dataChanges?: {
    count: number;
    items: PackageDataChange[];
    needsPodAdmin: boolean;
  };
  /**
   * The choice the pod recommends per `both` field, keyed `<rowId>:<field>`:
   * `catalog` when the pod's edit is already inside the catalog's text,
   * `combine` when the two edits merge without overlapping. Absent = no
   * recommendation; a person decides.
   */
  recommended?: Record<string, PackageUpdateChoiceName>;
  counts: PackageFieldCounts;
  needs: PackageUpdateNeeds;
}

/** A named choice for one field. */
export const PACKAGE_UPDATE_CHOICE_NAMES = [
  "catalog",
  "mine",
  "combine",
] as const;
export type PackageUpdateChoiceName =
  (typeof PACKAGE_UPDATE_CHOICE_NAMES)[number];

/**
 * What to do with one field:
 *   catalog — take the catalog's value;
 *   mine    — keep the pod's value (the catalog's becomes the new starting
 *             point, D4: asked again only when the catalog changes it again);
 *   combine — write the 3-way merge (a `both` text field without overlap);
 *   {value} — write this value (the person's own edit of the result).
 */
export const packageUpdateChoiceSchema = z.union([
  z.enum(PACKAGE_UPDATE_CHOICE_NAMES),
  z.object({ value: z.unknown() }).strict(),
]);
export type PackageUpdateChoice = z.infer<typeof packageUpdateChoiceSchema>;

export const applyPackageUpdateInputSchema = z.object({
  slug: z.string().min(1),
  /** The catalog version the page showed; a newer one answers 409. */
  expectedVersion: z.string().min(1),
  /**
   * Keyed `<rowId>:<field>`. Every `both` field needs one; an `updates` field
   * defaults to `catalog`; a `yours` field may take `catalog` to go back to
   * the catalog's value.
   */
  choices: z.record(z.string(), packageUpdateChoiceSchema).default({}),
  /** A space update's data changes the person agreed to (by id). */
  acceptDataChanges: z.array(z.string()).optional(),
});
export type ApplyPackageUpdateInput = z.input<
  typeof applyPackageUpdateInputSchema
>;

/** One field an apply (or an undo) changed. */
export interface PackageUpdateChange {
  rowKind: PackageUpdateRowKind;
  rowId: string;
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * The receipt of one package update — kept in the pod's event log as a
 * `package.updated` event. `source: 'automatic'` is the start-up pass applying
 * fields nobody edited (D3); `person` is an apply from a door.
 */
export interface PackageUpdateReceipt {
  id: string;
  slug: string;
  kind: string;
  name: string;
  fromVersion: string | null;
  toVersion: string | null;
  appliedAt: string;
  source: "person" | "automatic";
  changes: PackageUpdateChange[];
  /** Undo refuses after this instant (D5: 30 days). */
  undoUntil: string;
  /** When it was undone, or null. */
  undoneAt: string | null;
}

/**
 * The answer of an apply or an undo. A person's write lands and returns its
 * receipt; an agent's write is filed as proposals through each row's own
 * governed `.update` door, and lands only when a person approves them.
 */
export type PackageUpdateApplyResult =
  | {
      status: "applied";
      receipt: PackageUpdateReceipt | null;
      /**
       * A whole-package update that landed but did not finish (part of a
       * space's template waits on an approval or a setup): the pod's one
       * sentence for what is left.
       */
      warning?: string;
    }
  | { status: "proposed"; proposalIds: string[] };

export const undoPackageUpdateInputSchema = z.object({
  receiptId: z.string().uuid(),
});

export const detachPackageInputSchema = z.object({
  kind: z.enum(["view", "skill", "automation"]),
  id: z.string().uuid(),
});

/** How long a receipt can be undone (D5). */
export const PACKAGE_UPDATE_UNDO_WINDOW_DAYS = 30;

/** The event a package update writes to the pod's log. */
export const PACKAGE_UPDATED_EVENT_TYPE = "package.updated";
/** The event an undo writes; its data names the receipt it undid. */
export const PACKAGE_UPDATE_UNDONE_EVENT_TYPE = "package.update_undone";

/** Count fields per state. */
export function countPackageFields(
  fields: ReadonlyArray<{ state: PackageFieldState }>
): PackageFieldCounts {
  const counts: PackageFieldCounts = { updates: 0, yours: 0, both: 0, same: 0 };
  for (const f of fields) counts[f.state]++;
  return counts;
}

/** THE rule for what an update needs from a person (see PACKAGE_UPDATE_NEEDS). */
export function derivePackageUpdateNeeds(
  counts: PackageFieldCounts,
  dataChanges = 0
): PackageUpdateNeeds {
  if (dataChanges > 0) return "consent";
  if (counts.both > 0) return "choice";
  if (counts.updates > 0) return "review";
  return "nothing";
}

/**
 * What a whole-package update (`comparedBy: "package"`) needs from a person:
 * its consent when it would change existing records, else a look. There are
 * no fields to choose between, and it never applies on its own (a space's
 * template declares parts the start-up pass does not apply unattended).
 */
export function deriveWholePackageNeeds(dataChanges = 0): PackageUpdateNeeds {
  return dataChanges > 0 ? "consent" : "review";
}

/** The pod path that opens one update's review page. */
export function packageUpdateReviewPath(slug: string): string {
  return `/open/update/${encodeURIComponent(slug)}`;
}
