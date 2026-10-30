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

/** The kinds of installed row a plan compares today. */
export type PackageUpdateRowKind = "view" | "skill" | "automation";

/** One row of `GET /package-updates` / `packageUpdates.list`. */
export interface PackageUpdateSummary {
  slug: string;
  /** The catalog kind of the package (`skill`, `view`, `automation`). */
  kind: string;
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
  dataChanges?: { count: number; sentences: string[]; needsPodAdmin: boolean };
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
  | { status: "applied"; receipt: PackageUpdateReceipt | null }
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

/** The pod path that opens one update's review page. */
export function packageUpdateReviewPath(slug: string): string {
  return `/open/update/${encodeURIComponent(slug)}`;
}
