/**
 * Template data changes — TEMPLATE-LIFECYCLE Contract C.
 *
 * A template update can depend on a DATA cutover the conversion manifest
 * carries (`crm.deal-stage.commercial-fold` folds every deal's `dealStage` onto
 * `commercialStage`). Those ops are `deferAtBoot`: boot never runs them, so
 * until now they waited for an operator who might never come. This module is
 * how they ride `synap templates update` instead, with the person's consent:
 *
 *   - `opProfileSlugs(op)`        which profile slugs an op touches (derived
 *                                 exhaustively — a new op type without a
 *                                 mapping fails the BUILD);
 *   - `pendingTemplateDataChanges` the not-yet-ledgered ops that touch a
 *                                 template's profiles, each counted by the
 *                                 ENGINE's own dry run;
 *   - `dataChangeConsent`          which of them still need the person's yes;
 *   - `runConsentedDataChanges`    run exactly the accepted ones through the
 *                                 engine (ledgered, never the destructive tail).
 *
 * A pending op is a pod-wide fact: an op rewrites every row of its kind, in
 * every space, so `affected` is a pod-wide count, not this space's.
 */

import type { Sql } from "postgres";
import {
  CONVERSION_MANIFEST,
  type ConversionManifest,
  type ConversionOp,
} from "./manifest.js";
import {
  ensureConversionsLedger,
  opHasDestructiveTail,
  runConversions,
  type OpCounts,
  type RunSummary,
} from "./engine.js";
import { selectManifestOps } from "./select.js";

// ─── Which profiles an op touches ───────────────────────────────────────────

/** An op that touches every profile (no slug to name), e.g. an unscoped sweep. */
export const EVERY_PROFILE = "*" as const;

/** The profile slugs an op touches, or `EVERY_PROFILE`. */
export type OpProfileSlugs = readonly string[] | typeof EVERY_PROFILE;

/**
 * One deriver per op type. A MAPPED type over the `ConversionOp` union, so an
 * op type added to the union without an entry here is a missing property and
 * the build stops (the compile-time coverage floor, guards-and-tests.md).
 * Each entry names every slug field the op reads — source, target, family,
 * precondition — because a template that declares ANY of them is touched.
 */
const OP_PROFILE_SLUGS: {
  readonly [K in ConversionOp["op"]]: (
    op: Extract<ConversionOp, { op: K }>
  ) => OpProfileSlugs;
} = {
  declareKind: (op) => [op.slug],
  seedKindProfile: (op) => [op.slug],
  convertToFacet: (op) => [op.slug, op.targetKindSlug, ...op.applicableKinds],
  convertToKind: (op) => [op.slug, op.fromKindSlug, ...op.familySlugs],
  mergeInto: (op) => [...op.fromSlugs, op.intoSlug],
  keep: (op) => [op.slug],
  extractNonEntity: (op) => [op.slug],
  dedupeProfileRows: (op) => [op.slug],
  // `slug` here is a RELATION-def slug, and its edges hang off any profile.
  dedupeRelationDefs: () => EVERY_PROFILE,
  reconcileEntityScope: (op) => (op.slug ? [op.slug] : EVERY_PROFILE),
  reconcileFacetScope: (op) => (op.slug ? [op.slug] : EVERY_PROFILE),
  remapPropertyValues: (op) => [
    op.slug,
    ...(op.requiresCanonical ? [op.requiresCanonical.slug] : []),
  ],
  moveBasePropertyToFacet: (op) => [op.slug, op.facetSlug],
  renamePropertyKey: (op) => [
    op.slug,
    ...(op.requiresCanonical ? [op.requiresCanonical.slug] : []),
  ],
  remapFacetPropertyValues: (op) => [op.slug],
  foldRoleIntoStatus: (op) => [op.slug, ...op.targets.map((t) => t.role)],
  renameProfile: (op) => [op.slug, op.toSlug],
  // Fills lifecycle columns for EVERY kind or role that declares a lifecycle.
  projectLifecycleColumns: () => EVERY_PROFILE,
  foldBookingDealIntoLead: (op) => [
    op.slug,
    op.lead.personSlug,
    op.lead.role,
    op.companySlug,
    op.eventSlug,
  ],
};

export function opProfileSlugs(op: ConversionOp): OpProfileSlugs {
  const derive = OP_PROFILE_SLUGS[op.op] as (
    op: ConversionOp
  ) => OpProfileSlugs;
  return derive(op);
}

/** Does the op touch any of `profileSlugs`? */
export function opTouchesProfiles(
  op: ConversionOp,
  profileSlugs: ReadonlySet<string>
): boolean {
  const slugs = opProfileSlugs(op);
  if (slugs === EVERY_PROFILE) return true;
  return slugs.some((s) => profileSlugs.has(s));
}

// ─── How much an op changes ─────────────────────────────────────────────────

/**
 * Every `OpCounts` field, classified. CHANGED counters are rows the op writes;
 * LEFT_ALONE counters are rows it reports and deliberately does not touch.
 * Both lists are checked against `keyof OpCounts` below, so a new counter
 * nobody classified fails the build instead of silently not counting.
 */
const CHANGED_COUNTERS = [
  "profilesCreated",
  "profilesUpdated",
  "profilesDeactivated",
  "entitiesConverted",
  "entitiesRepointed",
  "facetsCreated",
  "facetsRepointed",
  "facetsDeactivated",
  "entitiesRescoped",
  "facetsRescoped",
  "viewsRewritten",
  "propertyDefsRepointed",
  "profilePropertiesRepointed",
  "entitiesRemapped",
  "facetPropertiesMoved",
  "entitiesBasePropertyStripped",
  "facetsRemapped",
  "facetsFolded",
  "entitiesRetyped",
  "entitiesKeyRenamed",
  "entitiesKeyConflicts",
  "relationDefsCollapsed",
  "profileRelationsRepointed",
  "profileRelationsMerged",
  "propertyDefRelationsRepointed",
  "relationDefsDeleted",
  "lifecycleColumnsProjected",
  "dealsConverted",
  "leadsAdvanced",
  "relationsCreated",
  "entitiesArchived",
] as const satisfies ReadonlyArray<keyof OpCounts>;

const _LEFT_ALONE_COUNTERS = [
  "entitiesParked",
  "facetsParked",
  "entitiesSkippedNoFacet",
  "relationDefsKept",
  // A subset of `lifecycleColumnsProjected`: rows whose value no option declares.
  "lifecycleUncategorized",
  // Booking deals a person edited, or with no linked person: kept, reported.
  "dealsKeptEdited",
  "dealsKeptNoPerson",
  "leadsUnjudged",
] as const satisfies ReadonlyArray<keyof OpCounts>;

type _CountersClassified =
  Exclude<
    keyof OpCounts,
    (typeof CHANGED_COUNTERS)[number]
  > extends (typeof _LEFT_ALONE_COUNTERS)[number]
    ? true
    : never;
const _countersClassified: _CountersClassified = true;
void _countersClassified;

/**
 * The number a person reads as "how many things change": the LARGEST changed
 * counter the op reports. Not the sum — one op reports the same rows under
 * several counters (a converted entity is also a created facet), and a sum
 * would count each thing twice.
 */
export function affectedFromCounts(counts: OpCounts): number {
  let max = 0;
  for (const key of CHANGED_COUNTERS) {
    const n = counts[key] ?? 0;
    if (n > max) max = n;
  }
  return max;
}

// ─── Plain-words description ────────────────────────────────────────────────

/** One sentence a person reads before agreeing. Exhaustive over op types. */
export function describeConversionOp(op: ConversionOp): string {
  switch (op.op) {
    case "declareKind":
      return `Make sure "${op.slug}" stays a kind of thing.`;
    case "seedKindProfile":
      return `Add the kind "${op.slug}".`;
    case "convertToFacet":
      return `Turn every "${op.slug}" into a "${op.targetKindSlug}" that wears the "${op.slug}" role.`;
    case "convertToKind":
      return `Turn every "${op.fromKindSlug}" wearing the "${op.slug}" role back into a "${op.slug}".`;
    case "mergeInto":
      return `Merge ${op.fromSlugs.map((s) => `"${s}"`).join(", ")} into "${op.intoSlug}".`;
    case "keep":
    case "extractNonEntity":
      return `Record a decision about "${op.slug}" (no data changes).`;
    case "dedupeProfileRows":
      return `Merge the duplicate "${op.slug}" kinds into one.`;
    case "dedupeRelationDefs":
      return op.slug
        ? `Merge the duplicate copies of the "${op.slug}" link into one.`
        : "Merge duplicate copies of links into one.";
    case "reconcileEntityScope":
      return op.slug
        ? `Make every "${op.slug}" visible in all spaces, as its kind says.`
        : "Make things whose kind is pod-wide visible in all spaces.";
    case "reconcileFacetScope":
      return op.slug
        ? `Make the "${op.slug}" role visible in all spaces.`
        : "Make pod-wide roles visible in all spaces.";
    case "remapPropertyValues":
      // In place (sourceKey === targetKey) nothing is moved or removed: only
      // the old values are translated.
      return op.sourceKey === op.targetKey
        ? `Translate the old "${op.sourceKey}" values of each "${op.slug}" to the new ones.`
        : `Move each "${op.slug}"'s "${op.sourceKey}" onto "${op.targetKey}", translating the values, then remove "${op.sourceKey}".`;
    case "moveBasePropertyToFacet":
      return `Move each "${op.slug}"'s "${op.sourceKey}" onto its "${op.facetSlug}" role.`;
    case "renamePropertyKey":
      return `Rename the "${op.sourceKey}" field of each "${op.slug}" to "${op.targetKey}".`;
    case "remapFacetPropertyValues":
      return op.sourceKey === op.targetKey
        ? `Translate the old "${op.sourceKey}" values of the "${op.slug}" role to the new ones.`
        : `Move the "${op.slug}" role's "${op.sourceKey}" onto "${op.targetKey}", translating the values.`;
    case "foldRoleIntoStatus":
      return `Retire the "${op.slug}" role: record it as a status on ${op.targets
        .map((t) => `"${t.role}"`)
        .join(" or ")} instead.`;
    case "renameProfile":
      return `Rename the kind "${op.slug}" to "${op.toSlug}".`;
    case "projectLifecycleColumns":
      return "Fill in each thing's lifecycle status from the value it already holds.";
    case "foldBookingDealIntoLead":
      return `Turn each untouched booked-call "${op.slug}" into a "${op.lead.role}" at "${op.lead.status}" on its person, linking the call; edited ones are kept.`;
    default: {
      const unhandled: never = op;
      return unhandled;
    }
  }
}

// ─── Pending changes for a template ─────────────────────────────────────────

/** One pending data change, as `synap templates update` shows it. */
export interface TemplateDataChange {
  /** The manifest op key — what `acceptDataChanges` names. */
  opKey: string;
  /** One plain sentence. */
  description: string;
  /**
   * How many things the op would change, pod-wide (`affectedFromCounts` of the
   * engine's own dry run). `null` when the dry run FAILED — unmeasured, never
   * folded into 0; `error` then says why.
   */
  affected: number | null;
  /**
   * The op has a destructive tail (it retires profile rows). The engine refuses
   * to run such an op without that tail, so it is NEVER run by the update
   * door: it is an operator step (`operatorCommand`).
   */
  destructive: boolean;
  /** The dry run's raw counts (empty when it failed). */
  counts: OpCounts;
  error?: string;
  /** Destructive only: the operator command, dry run first. */
  operatorCommand?: string;
}

/** The ledgered (successfully applied) op keys. */
async function appliedOpKeys(sql: Sql): Promise<Set<string>> {
  await ensureConversionsLedger(sql);
  const rows = await sql<Array<{ op_key: string }>>`
    SELECT op_key FROM "_conversions" WHERE error IS NULL AND dry_run = false
  `;
  return new Set(rows.map((r) => r.op_key));
}

function operatorCommandFor(opKey: string): string {
  return (
    `pnpm --filter @synap/database conversions --only ${opKey}  # dry run, then: ` +
    `--apply --only ${opKey} --destructive-tail`
  );
}

/**
 * The data changes a template with these profile slugs is waiting on: every
 * manifest op not yet ledgered that touches one of `profileSlugs`, counted by
 * the engine's own dry run (one run per op, so one failing count never hides
 * the others). Ops that would change nothing (`affected === 0`) are left out:
 * there is nothing to agree to. An op whose count failed stays IN, unmeasured.
 *
 * Each op is dry-run on its own, against today's data: an op that only has
 * rows to change after an EARLIER pending op runs (a key rename after a kind
 * rename) counts what exists now, which can be fewer than it will touch.
 */
export async function pendingTemplateDataChanges(
  sql: Sql,
  profileSlugs: Iterable<string>,
  manifest: ConversionManifest = CONVERSION_MANIFEST
): Promise<TemplateDataChange[]> {
  const wanted = new Set(profileSlugs);
  if (wanted.size === 0) return [];
  const applied = await appliedOpKeys(sql);
  const candidates = manifest.ops.filter(
    (op) => !applied.has(op.opKey) && opTouchesProfiles(op, wanted)
  );

  const changes: TemplateDataChange[] = [];
  for (const op of candidates) {
    const destructive = opHasDestructiveTail(op);
    let summary: RunSummary;
    try {
      summary = await runConversions(
        sql,
        selectManifestOps(manifest, [op.opKey]),
        { dryRun: true, destructiveTail: false }
      );
    } catch (err) {
      summary = {
        dryRun: true,
        destructiveTail: false,
        hadError: true,
        results: [
          {
            opKey: op.opKey,
            op: op.op,
            status: "error",
            counts: {},
            error: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
    const result = summary.results.find((r) => r.opKey === op.opKey);
    const failed = !result || result.status === "error";
    const counts = failed ? {} : result.counts;
    const affected = failed ? null : affectedFromCounts(counts);
    if (affected === 0) continue;
    changes.push({
      opKey: op.opKey,
      description: describeConversionOp(op),
      affected,
      destructive,
      counts,
      ...(failed
        ? { error: result?.error ?? "the dry run returned no result" }
        : {}),
      ...(destructive ? { operatorCommand: operatorCommandFor(op.opKey) } : {}),
    });
  }
  return changes;
}

// ─── Consent ────────────────────────────────────────────────────────────────

export interface DataChangeConsent {
  /**
   * True when every consentable change is accepted. Destructive changes never
   * enter this: they are operator steps, so they can never block an update.
   */
  ok: boolean;
  /** Consentable changes the caller did not accept. */
  missing: TemplateDataChange[];
  /** The consentable changes to run, in manifest order. */
  toRun: TemplateDataChange[];
  /** Destructive changes: never run here, printed as operator steps. */
  operatorSteps: TemplateDataChange[];
  /**
   * Accepted keys naming a destructive change. Not run and not blocking: the
   * door echoes them back so the caller is told they stay an operator step.
   */
  destructiveAccepted: string[];
}

/**
 * Which pending changes the caller's `acceptDataChanges` covers. Only the
 * non-destructive ones are consentable here. A destructive one is an operator
 * step: it never blocks the update, and accepting it runs nothing — it is
 * reported back (`destructiveAccepted`) so the caller is told, not ignored. Keys
 * naming no pending change (already applied by someone else, or unrelated)
 * are harmless and ignored.
 */
export function dataChangeConsent(
  pending: readonly TemplateDataChange[],
  accept: readonly string[] | undefined
): DataChangeConsent {
  const accepted = new Set(accept ?? []);
  const consentable = pending.filter((c) => !c.destructive);
  const operatorSteps = pending.filter((c) => c.destructive);
  const missing = consentable.filter((c) => !accepted.has(c.opKey));
  const destructiveAccepted = operatorSteps
    .filter((c) => accepted.has(c.opKey))
    .map((c) => c.opKey);
  return {
    ok: missing.length === 0,
    missing,
    toRun: consentable,
    operatorSteps,
    destructiveAccepted,
  };
}

/**
 * Run the accepted changes through the ENGINE: one transaction per op, each
 * ledgered with its counts, halting at the first failure (earlier ops stay
 * applied and ledgered — they are idempotent, so a retry skips them). Never
 * the destructive tail: a destructive op reaching here is refused by the engine
 * (THE LEDGER TRAP), which is why `dataChangeConsent` never puts one in `toRun`.
 */
export async function runConsentedDataChanges(
  sql: Sql,
  opKeys: readonly string[],
  manifest: ConversionManifest = CONVERSION_MANIFEST
): Promise<RunSummary> {
  return runConversions(sql, selectManifestOps(manifest, opKeys), {
    dryRun: false,
    destructiveTail: false,
  });
}

/** Does any pending change hold back a template stamp? (consentable ones only) */
export function holdsTemplateStamp(
  pending: readonly TemplateDataChange[]
): boolean {
  return pending.some((c) => !c.destructive);
}
