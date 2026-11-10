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
import { foldProcessIntoSubjectProfile } from "../../schemas/playbook-process.js";

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
  // MANAGED, deliberately. A template declares what its playbooks NEED the pod
  // to be able to do, so a change to that declaration must REACH an installed
  // pod — the same reason `stages`/`criteria` are managed. Leaving it out is
  // precisely the defect backend-rules.md records: a field the applier writes
  // but the reconcile never compares reaches ZERO pods, silently and forever,
  // because the baseline is stamped from the same projection that skipped it.
  //
  // Reconciling the DECLARATION is not gating SATISFIABILITY: the reconcile
  // diffs what a template declares against what a pod has, and a gap is
  // reported (see `matchRequiredIntents`), never refused.
  "requiredIntents",
  // MANAGED for the same reason: a template that changes the rules its
  // playbook follows (a ref added, a filter narrowed) must reach installed
  // pods. Refs, never ids, so the declaration is the same on every pod.
  "guidance",
  "subjectProfile",
  "schedule",
  "executor",
  "scope",
  // The tools it needs (0416) are part of what the step IS: a template
  // change must reach installed pods like `stages` does.
  "requires",
  // Who runs it (0416) is projected (an install carries the template's
  // runner) but POD-OWNED on every later pass: see `POD_OWNED_RUNNER` below.
  "runner",
] as const satisfies ReadonlyArray<keyof PackagePlaybookDefinition>;

/**
 * Definition fields deliberately NOT reconciled, each with its reason:
 *  - `name`     — the MATCH key (reuse-by-name); a rename is a new playbook.
 *  - `status`   — owner lifecycle (activate / pause / archive); a template
 *                 default must never re-activate a playbook the owner paused.
 *  - `metadata` — the owner's bag, and it CARRIES `marketSource` itself.
 *  - `grants`   — link edges, not row fields; re-ensured idempotently on every
 *                 apply by `grantPlaybookLinks`.
 *  - `activators` / `humanOnlyStatuses` — NOT unreconciled: they have no
 *                 column and are FOLDED into `subjectProfile` (managed) by
 *                 {@link projectPlaybookDefinition} through the one fold
 *                 (`foldProcessIntoSubjectProfile`), so a template change to
 *                 them reaches pods as a `subjectProfile` change. Listed here
 *                 only because they are not row fields of their own.
 */
export const PLAYBOOK_UNMANAGED_FIELDS = [
  "name",
  "status",
  "metadata",
  "grants",
  "activators",
  "humanOnlyStatuses",
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
  // The process declarations ride INSIDE `subjectProfile` (no column of their
  // own) — folded here so the applier's create, the stamped baseline and the
  // reconcile's `desired` all carry them, through the ONE fold.
  const folded = foldProcessIntoSubjectProfile(
    def as Parameters<typeof foldProcessIntoSubjectProfile>[0]
  );
  if (folded !== undefined) out.subjectProfile = folded;
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
  /**
   * POD-OWNED changes the template made that this pass did NOT apply: the
   * playbook's `runner` (`"runner"`) or a step's (`"stages.<key>.runner"`).
   * Each is a keep-or-drop line for a person (apply it with
   * `playbooks.update`); it stays listed until they do or the template
   * reverts it.
   */
  held: string[];
}

/**
 * WHO RUNS IT is the pod's (founder via the lead, 9 Nov 2026: a template says
 * what to do; which person, agent or computer does it on this pod is the pod's
 * choice — "Claude Code on my Mac" for a step must survive a catalog update).
 * So a playbook's `runner` and every stage's `runner` are installed from the
 * template once, then never written by a reconcile: a template that changes
 * one is reported `held` (a keep-or-drop line), the row keeps its value and
 * the baseline keeps the template's old value, so the line stays offered. A
 * stage the template adds takes the template's runner (there is nothing of
 * the pod's to keep). The merge reads `stages` WITHOUT runners, like lessons,
 * so a pod's runner never freezes the template's other stage changes.
 */
const POD_OWNED_RUNNER = "runner";

function stagesWithoutRunners(stages: unknown): unknown {
  if (!Array.isArray(stages)) return stages;
  return stages.map((stage) => {
    if (!stage || typeof stage !== "object" || !("runner" in stage)) {
      return stage;
    }
    const { runner: _runner, ...rest } = stage as Record<string, unknown>;
    return rest;
  });
}

/** key → the stage's runner (absent key = the stage names none). */
function stageRunners(stages: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(stages)) return out;
  for (const stage of stages) {
    if (!stage || typeof stage !== "object") continue;
    const { key, runner } = stage as { key?: unknown; runner?: unknown };
    if (typeof key === "string" && runner !== undefined) out.set(key, runner);
  }
  return out;
}

function stageKeys(stages: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(stages)) return out;
  for (const stage of stages) {
    const key = (stage as { key?: unknown } | null)?.key;
    if (typeof key === "string") out.add(key);
  }
  return out;
}

/** `stages` with each stage's runner set from `runners` (absent = none). */
function withStageRunners(
  stages: unknown,
  runnerOf: (key: string, stage: Record<string, unknown>) => unknown
): unknown {
  if (!Array.isArray(stages)) return stages;
  return stages.map((stage) => {
    if (!stage || typeof stage !== "object") return stage;
    const s = stage as Record<string, unknown>;
    if (typeof s.key !== "string") return stage;
    const { runner: _drop, ...rest } = s;
    const runner = runnerOf(s.key, s);
    return runner === undefined ? rest : { ...rest, runner };
  });
}

/**
 * The pod-owned runners of one pass: which template runner changes are held,
 * the runners the row keeps, and the baseline's runners afterwards (the old
 * template value where held, so the line stays offered).
 */
function planPodOwnedRunners(p: {
  live: Record<string, unknown>;
  /** The template's previous values; `null` on adoption (no baseline yet). */
  baseline: Record<string, unknown> | null;
  desired: Record<string, unknown>;
}): {
  held: string[];
  /** The top-level runner to write (adoption of an empty one), if any. */
  adoptRunner: { value: unknown } | null;
  baselineRunner: unknown;
  liveStageRunner: (key: string) => unknown;
  baselineStageRunner: (key: string, desiredRunner: unknown) => unknown;
} {
  const held: string[] = [];
  const changed = (d: unknown, b: unknown, l: unknown) =>
    p.baseline === null
      ? !deepEqual(d, l) && !isEmptyRunner(l)
      : !deepEqual(d, b) && !deepEqual(d, l);
  // The playbook's runner.
  const dTop = p.desired[POD_OWNED_RUNNER];
  const bTop = p.baseline?.[POD_OWNED_RUNNER];
  const lTop = p.live[POD_OWNED_RUNNER];
  let adoptRunner: { value: unknown } | null = null;
  let baselineRunner: unknown = dTop;
  if (dTop !== undefined) {
    if (p.baseline === null && isEmptyRunner(lTop) && !isEmptyRunner(dTop)) {
      adoptRunner = { value: dTop };
    } else if (changed(dTop, bTop, lTop)) {
      held.push(POD_OWNED_RUNNER);
      baselineRunner = p.baseline === null ? lTop : bTop;
    }
  }
  // Each stage's runner.
  const dStages = stageRunners(p.desired.stages);
  const bStages = stageRunners(p.baseline?.stages);
  const lStages = stageRunners(p.live.stages);
  const liveKeys = stageKeys(p.live.stages);
  const heldStages = new Set<string>();
  for (const key of stageKeys(p.desired.stages)) {
    if (!liveKeys.has(key)) continue; // a new step: the template's runner
    const d = dStages.get(key);
    const l = lStages.get(key);
    const b = bStages.get(key);
    const differs =
      p.baseline === null
        ? !deepEqual(d, l)
        : !deepEqual(d, b) && !deepEqual(d, l);
    if (differs) {
      heldStages.add(key);
      held.push(`stages.${key}.${POD_OWNED_RUNNER}`);
    }
  }
  return {
    held,
    adoptRunner,
    baselineRunner,
    liveStageRunner: (key) =>
      liveKeys.has(key) ? lStages.get(key) : dStages.get(key),
    baselineStageRunner: (key, desiredRunner) =>
      heldStages.has(key)
        ? p.baseline === null
          ? lStages.get(key)
          : bStages.get(key)
        : desiredRunner,
  };
}

function isEmptyRunner(v: unknown): boolean {
  return v === null || v === undefined;
}

/**
 * A stage's `lessons` belong to the POD, not to the template or the owner: the
 * lessons scanner revises them on the live row (`playbook-lessons-scanner.ts`,
 * an approved `playbook/update`), and no template writes them. Compared as part
 * of `stages`, one learned lesson made the live stages differ from the baseline,
 * so the 3-way merge called the whole field OWNER-OWNED and no template change
 * to any stage reached that pod again, silently ("Draft a first message",
 * 6 Nov 2026: its goal followed the catalog, its stages kept text the catalog
 * had dropped 3 days earlier). So the merge reads the live stages WITHOUT their
 * lessons, and a stage the template advances keeps the lessons its live twin
 * (same `key`) had learned, unless the template declares its own.
 */
function stagesWithoutLessons(stages: unknown): unknown {
  if (!Array.isArray(stages)) return stages;
  return stages.map((stage) => {
    if (!stage || typeof stage !== "object" || !("lessons" in stage)) {
      return stage;
    }
    const { lessons: _lessons, ...rest } = stage as Record<string, unknown>;
    return rest;
  });
}

function graftStageLessons(next: unknown, liveStages: unknown): unknown {
  if (!Array.isArray(next) || !Array.isArray(liveStages)) return next;
  const learned = new Map<string, unknown>();
  for (const stage of liveStages) {
    if (!stage || typeof stage !== "object") continue;
    const { key, lessons } = stage as { key?: unknown; lessons?: unknown };
    if (typeof key === "string" && Array.isArray(lessons) && lessons.length) {
      learned.set(key, lessons);
    }
  }
  if (learned.size === 0) return next;
  return next.map((stage) => {
    if (!stage || typeof stage !== "object") return stage;
    const s = stage as Record<string, unknown>;
    if (s.lessons !== undefined || typeof s.key !== "string") return stage;
    const lessons = learned.get(s.key);
    return lessons ? { ...s, lessons } : stage;
  });
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
    held: [],
  };
  if (source && source.packageSlug !== packageSlug) {
    return { ...none, kind: "foreign" };
  }

  const parsed = packagePlaybookDefinitionSchema.parse(args.templateElement);
  const desiredFull = projectPlaybookDefinition(parsed) as Record<
    string,
    unknown
  >;
  const liveFull: Record<string, unknown> = {};
  for (const k of PLAYBOOK_MANAGED_FIELDS) liveFull[k] = row[k];
  // Learned lessons are the pod's, never an owner edit (see stagesWithoutLessons).
  liveFull.stages = stagesWithoutLessons(row.stages);
  // Who runs it is the pod's (see POD_OWNED_RUNNER): the merge never sees it.
  const withoutRunners = (v: Record<string, unknown>) => {
    const { [POD_OWNED_RUNNER]: _r, ...rest } = v;
    return "stages" in rest
      ? { ...rest, stages: stagesWithoutRunners(rest.stages) }
      : rest;
  };
  const desired = withoutRunners(desiredFull);
  const live = withoutRunners(liveFull);
  const managedForMerge = PLAYBOOK_MANAGED_FIELDS.filter(
    (k) => k !== POD_OWNED_RUNNER
  );
  /** The written stages keep the pod's runners (a new step takes the template's). */
  const runnersOnto = (
    stages: unknown,
    runners: ReturnType<typeof planPodOwnedRunners>
  ) => withStageRunners(stages, (key) => runners.liveStageRunner(key));
  /** The baseline keeps the template's runners, the old value where held. */
  const baselineWithRunners = (
    next: Record<string, unknown>,
    runners: ReturnType<typeof planPodOwnedRunners>
  ): Record<string, unknown> => {
    const dStages = stageRunners(desiredFull.stages);
    const out: Record<string, unknown> = { ...next };
    if (POD_OWNED_RUNNER in desiredFull) {
      out[POD_OWNED_RUNNER] = runners.baselineRunner;
    }
    if (out.stages !== undefined) {
      out.stages = withStageRunners(out.stages, (key) =>
        runners.baselineStageRunner(key, dStages.get(key))
      );
    }
    return out;
  };

  if (!source) {
    const patch: Record<string, unknown> = {};
    const applied: string[] = [];
    const ownerOwned: string[] = [];
    const runners = planPodOwnedRunners({
      live: liveFull,
      baseline: null,
      desired: desiredFull,
    });
    for (const k of managedForMerge) {
      if (!(k in desired)) continue;
      if (deepEqual(live[k], desired[k])) continue;
      if (isEmptyDefault(k, live[k])) {
        patch[k] = desired[k];
        applied.push(k);
      } else {
        ownerOwned.push(k);
      }
    }
    if (patch.stages !== undefined) {
      patch.stages = graftStageLessons(
        runnersOnto(patch.stages, runners),
        row.stages
      );
    }
    if (runners.adoptRunner) {
      patch[POD_OWNED_RUNNER] = runners.adoptRunner.value;
      applied.push(POD_OWNED_RUNNER);
    }
    const stamp: MarketSource = buildMarketSource(
      baselineWithRunners(desired, runners),
      { packageSlug, packageVersion, installedAt }
    );
    return {
      kind: "adopted",
      patch,
      metadata: stampMarketSource(metadata, stamp),
      applied,
      ownerOwned,
      held: runners.held,
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
  for (const k of managedForMerge) {
    if (!(k in source.baseline) && isEmptyDefault(k, live[k])) {
      mergeLive[k] = undefined;
    }
  }
  const baseline = source.baseline as Record<string, unknown>;
  const runners = planPodOwnedRunners({
    live: liveFull,
    baseline,
    desired: desiredFull,
  });
  const r = threeWayMergeFields(mergeLive, withoutRunners(baseline), desired);
  const patch: Record<string, unknown> = {};
  for (const k of r.applied) patch[k] = r.merged[k];
  if (patch.stages !== undefined) {
    patch.stages = graftStageLessons(
      runnersOnto(patch.stages, runners),
      row.stages
    );
  }
  const nextBaseline = baselineWithRunners(r.nextBaseline, runners);
  const baselineMoved = !deepEqual(nextBaseline, source.baseline);
  if (!r.changed && !baselineMoved) {
    return { ...none, ownerOwned: r.ownerOwned, held: runners.held };
  }
  return {
    kind: r.changed ? "updated" : "up-to-date",
    patch,
    metadata: {
      ...metadata,
      marketSource: {
        ...source,
        packageVersion: packageVersion ?? source.packageVersion,
        baseline: nextBaseline,
      },
    },
    applied: r.applied,
    ownerOwned: r.ownerOwned,
    held: runners.held,
  };
}
