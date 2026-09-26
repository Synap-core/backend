/**
 * playbook-market-source — the source-link + managed-field contract for a
 * playbook INSTALLED FROM A PACKAGE (workspace template, pack, capability).
 *
 * WHY. A package re-install / template update never reached an installed
 * playbook: the applier REUSES a playbook by (workspace, lower(name)) and never
 * updated it, and the boot reconcile explicitly did not handle playbooks. So
 * grants.yaml's 6-step "Grant Process", stripped to a stageless session by the
 * old door schemas, could never be repaired by shipping the fix.
 *
 * This reuses the SAME mechanism views/skills/automations use
 * (`capabilities/market-source.ts`): a `metadata.marketSource` stamp
 * `{packageSlug, packageVersion, installedAt, baseline}` and the field-level
 * 3-way merge `threeWayMergeFields` — a field advances to the template only
 * while the row still holds the value we last wrote; a field the owner edited
 * is OWNER-OWNED, left alone and reported, never forced.
 *
 * INVARIANT 2 (backend-rules): the managed field set is DERIVED from the
 * applier's projection, never hand-maintained apart from it. The applier writes
 * a package playbook as `caller.create({ ...projectPlaybookDefinition(def),
 * <UNMANAGED keys> })` — so `PLAYBOOK_MANAGED_FIELDS` IS the projection, the
 * baseline is recorded from exactly that projection, and the reconcile's
 * `desired` is built by the same function. Two guards keep it that way:
 *  - the compile-time floor below: every key of the package playbook schema is
 *    classified MANAGED or UNMANAGED, so a new schema field stops the build
 *    until someone decides;
 *  - `playbook-market-source.projection-parity.tripwire.test.ts` parses the
 *    applier's own `caller.create({...})` and refuses any key written outside
 *    the projection that is not declared UNMANAGED.
 *
 * INVARIANT 1: the per-row baseline asserts only the fields the applier wrote
 * and the comparator reads (the SAME list) — a narrowed marker.
 *
 * Running tracks are never touched: a track runs off its own
 * `definition_snapshot` (types/units/track.ts), and this module only ever
 * writes the `playbooks` row through the governed `playbooks.update` door. A
 * template update therefore reaches the NEXT track started from the playbook,
 * never a live one.
 *
 * Pure: no clock, no database. The effectful half is
 * `reconcile-installed-playbooks.ts`.
 */

import {
  buildMarketSource,
  deepEqual,
  readMarketSource,
  stampMarketSource,
  threeWayMergeFields,
  type MarketSource,
} from "../capabilities/market-source.js";
import {
  packagePlaybookDefinitionSchema,
  type PackagePlaybookDefinition,
} from "../../schemas/playbook-definition.js";

/** Definition fields the applier writes from the template — reconciled. */
export const PLAYBOOK_MANAGED_FIELDS = [
  "description",
  "goalTemplate",
  "params",
  "inputStrategy",
  "channelSpec",
  "expectedOutputs",
  "stages",
  "criteria",
  "subjectProfile",
  "schedule",
  "executor",
  "scope",
] as const satisfies ReadonlyArray<keyof PackagePlaybookDefinition>;

/**
 * Definition fields deliberately NOT reconciled, each with its reason:
 *  - `name`     — the MATCH key (reuse-by-name); a rename is a new playbook.
 *  - `status`   — owner lifecycle (activate / pause / archive); a template
 *                 default must never re-activate a playbook the owner paused.
 *  - `metadata` — the owner's bag, and it CARRIES `marketSource` itself.
 *  - `grants`   — link edges, not row fields; re-ensured idempotently on every
 *                 apply by `grantPlaybookLinks`.
 */
export const PLAYBOOK_UNMANAGED_FIELDS = [
  "name",
  "status",
  "metadata",
  "grants",
] as const satisfies ReadonlyArray<keyof PackagePlaybookDefinition>;

export type PlaybookManagedField = (typeof PLAYBOOK_MANAGED_FIELDS)[number];

// Compile-time coverage floor: a field added to the package playbook schema
// that is in neither list makes `_Classified` `never` ⇒ the build stops.
type _Classified =
  Exclude<
    keyof PackagePlaybookDefinition,
    PlaybookManagedField | (typeof PLAYBOOK_UNMANAGED_FIELDS)[number]
  > extends never
    ? true
    : never;
const _classified: _Classified = true;
void _classified;

/**
 * THE projection: the managed fields of a (loose) definition, keys whose value
 * is `undefined` omitted. The applier spreads this into `playbooks.create`, the
 * baseline is stamped from it, and the reconcile builds `desired` with it.
 */
export function projectPlaybookDefinition<
  T extends Partial<Record<PlaybookManagedField, unknown>>,
>(def: T): Pick<T, PlaybookManagedField & keyof T> {
  const out: Record<string, unknown> = {};
  for (const k of PLAYBOOK_MANAGED_FIELDS) {
    const v = (def as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Pick<T, PlaybookManagedField & keyof T>;
}

/** Stamp the source-link on a freshly-created package playbook's metadata. */
export function stampPlaybookMarketSource(
  metadata: Record<string, unknown> | undefined,
  projected: Record<string, unknown>,
  opts: {
    packageSlug: string;
    packageVersion?: string | null;
    installedAt: string;
  }
): Record<string, unknown> {
  return stampMarketSource(metadata, buildMarketSource(projected, opts));
}

/**
 * The DB column defaults a row carries for a field the create never set. A
 * live value equal to one of these is "never authored" — ADOPT may fill it.
 */
function isEmptyDefault(k: PlaybookManagedField, v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 0) return true;
    // inputStrategy's column default is `{ kind: "none" }`.
    return k === "inputStrategy" && deepEqual(v, { kind: "none" });
  }
  return typeof v === "string" && v.length === 0;
}

export type PlaybookReconcileKind =
  "up-to-date" | "updated" | "adopted" | "foreign";

export interface PlaybookReconcilePlan {
  kind: PlaybookReconcileKind;
  /** Managed fields to WRITE (only fields that change). Empty = no row write. */
  patch: Record<string, unknown>;
  /** The full metadata bag to persist (with the advanced `marketSource`), or
   *  null when metadata need not change. */
  metadata: Record<string, unknown> | null;
  applied: string[];
  /** Fields the owner edited — left alone, reported. */
  ownerOwned: string[];
}

/**
 * Plan how an installed playbook row converges to its template element.
 *
 *  - Row carries a `marketSource` for ANOTHER package → `foreign`, untouched.
 *  - Row carries this package's `marketSource` → 3-way merge against its
 *    baseline (the ONE merge in market-source.ts).
 *  - Row has NO `marketSource` (installed before this existed, or by the old
 *    stripping doors) → ADOPT: a managed field that is still the column
 *    default, or already equals the template, advances to the template; a
 *    field holding any OTHER value is owner-owned (reported). The baseline
 *    records the template value for every managed field, so an owner-owned
 *    field stays detected on every later pass.
 *
 * `templateElement` is parsed through the package playbook schema so `desired`
 * is normalized exactly as the install's baseline was.
 */
export function planPlaybookReconcile(args: {
  row: Record<string, unknown>;
  templateElement: unknown;
  packageSlug: string;
  packageVersion: string | null;
  installedAt: string;
}): PlaybookReconcilePlan {
  const { row, packageSlug, packageVersion, installedAt } = args;
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  const source = readMarketSource(metadata);
  const none: PlaybookReconcilePlan = {
    kind: "up-to-date",
    patch: {},
    metadata: null,
    applied: [],
    ownerOwned: [],
  };
  if (source && source.packageSlug !== packageSlug) {
    return { ...none, kind: "foreign" };
  }

  const parsed = packagePlaybookDefinitionSchema.parse(args.templateElement);
  const desired = projectPlaybookDefinition(parsed) as Record<string, unknown>;
  const live: Record<string, unknown> = {};
  for (const k of PLAYBOOK_MANAGED_FIELDS) live[k] = row[k];

  if (!source) {
    const patch: Record<string, unknown> = {};
    const applied: string[] = [];
    const ownerOwned: string[] = [];
    for (const k of PLAYBOOK_MANAGED_FIELDS) {
      if (!(k in desired)) continue;
      if (deepEqual(live[k], desired[k])) continue;
      if (isEmptyDefault(k, live[k])) {
        patch[k] = desired[k];
        applied.push(k);
      } else {
        ownerOwned.push(k);
      }
    }
    const stamp: MarketSource = buildMarketSource(desired, {
      packageSlug,
      packageVersion,
      installedAt,
    });
    return {
      kind: "adopted",
      patch,
      metadata: stampMarketSource(metadata, stamp),
      applied,
      ownerOwned,
    };
  }

  // Managed set for an existing link = the baseline's keys ∪ the template's
  // current managed keys: a field the CURRENT projection manages but an older
  // baseline predates (e.g. `scope`/`stages` on a row the stripping doors
  // installed) enters through `threeWayMergeFields`' newly-managed branch,
  // which never stomps a diverging owner value.
  // A field the baseline never recorded that still holds its COLUMN DEFAULT
  // (`scope` null, `stages` []) was never authored: present it to the merge as
  // absent so the newly-managed branch adopts the template value instead of
  // mistaking the default for an owner edit.
  const mergeLive: Record<string, unknown> = { ...live };
  for (const k of PLAYBOOK_MANAGED_FIELDS) {
    if (!(k in source.baseline) && isEmptyDefault(k, live[k])) {
      mergeLive[k] = undefined;
    }
  }
  const r = threeWayMergeFields(mergeLive, source.baseline, desired);
  const patch: Record<string, unknown> = {};
  for (const k of r.applied) patch[k] = r.merged[k];
  const baselineMoved = !deepEqual(r.nextBaseline, source.baseline);
  if (!r.changed && !baselineMoved) {
    return { ...none, ownerOwned: r.ownerOwned };
  }
  return {
    kind: r.changed ? "updated" : "up-to-date",
    patch,
    metadata: {
      ...metadata,
      marketSource: {
        ...source,
        packageVersion: packageVersion ?? source.packageVersion,
        baseline: r.nextBaseline,
      },
    },
    applied: r.applied,
    ownerOwned: r.ownerOwned,
  };
}
