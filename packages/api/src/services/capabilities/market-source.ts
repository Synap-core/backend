/**
 * market-source — the source-link contract for STANDALONE config installs
 * (view / skill / automation) and the field-level 3-way merge that lets them
 * reconcile to their source template WITHOUT ever destroying a user's edits.
 *
 * WHY THIS EXISTS. Workspace installs carry their source-link in a real
 * `package_slug` column; capability installs carry it in `metadata.templateKey`.
 * The three lighter config kinds had NO source-link at all, so they could never
 * self-heal (a published fix never reached an installed automation) and a
 * re-install duplicated them. This module gives them the same linkage —
 * deliberately in the existing `metadata` jsonb (no migration), matching the
 * capability precedent.
 *
 * WHY A 3-WAY MERGE (the load-bearing safety property). "Source-linked reconcile"
 * is the exact place the Salesforce-managed / naive-GitOps disaster lives:
 * reconcile silently reverting a field the user edited. The guardrail is
 * field-level owner-ownership — a per-field 3-way merge of
 *   base  = the value AS INSTALLED (the last value WE wrote), stored in `baseline`
 *   live  = the value in the row right now
 *   desired = the template's new value
 * A field is updated from the template ONLY when `live` still deep-equals `base`
 * (untouched since we wrote it). The moment `live` diverges from `base`, the field
 * is OWNER-OWNED and is never overwritten — reported, never forced. `prune` is OFF:
 * a field the template dropped is left on the row, not deleted. This mirrors
 * GitOps `ignoreDifferences` and is the same "reported, never forced" stance the
 * capability reconcile already takes for unresolved params.
 *
 * This module reads NO clock and touches NO database — pure data, fully unit-
 * testable. Callers pass `installedAt`; the install-side stamps, the reconcile
 * engine merges, the detach door clears.
 */

/** The source-link stamped into a standalone config row's `metadata.marketSource`. */
export interface MarketSource {
  /** The CP package slug this config was installed from — the reconcile key. */
  packageSlug: string;
  /** The package version at install time, or null when unknown. */
  packageVersion: string | null;
  /** ISO timestamp of install. Supplied by the caller (this module reads no clock). */
  installedAt: string;
  /**
   * The reconcilable fields AS INSTALLED — the BASE of every future 3-way merge.
   * Keyed by the row field name the applier wrote from the definition (e.g.
   * `name`, `description`, `flowDefinition`, `config`, `query`, `prompt`). A field
   * absent here is simply not managed by reconcile.
   */
  baseline: Record<string, unknown>;
}

const MARKET_SOURCE_KEY = "marketSource";

/** JSON round-trip clone — every value we handle is jsonb (JSON-serializable). */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/** Order-insensitive structural equality for jsonb values. `undefined` and an
 *  absent key compare equal (both serialize away). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    // Only equal if both are nullish (=== already handled the same-ref case).
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Build the `marketSource` stamp for a freshly-installed config. `fields` = the
 * exact reconcilable values the applier just wrote from the definition; they
 * become the baseline. Clone so a later mutation of the caller's object can't
 * retroactively alter the recorded baseline.
 */
export function buildMarketSource(
  fields: Record<string, unknown>,
  opts: {
    packageSlug: string;
    packageVersion?: string | null;
    installedAt: string;
  }
): MarketSource {
  return {
    packageSlug: opts.packageSlug,
    packageVersion: opts.packageVersion ?? null,
    installedAt: opts.installedAt,
    baseline: jsonClone(fields),
  };
}

/** Non-destructively merge a `marketSource` stamp into an existing metadata bag. */
export function stampMarketSource(
  metadata: Record<string, unknown> | null | undefined,
  source: MarketSource
): Record<string, unknown> {
  return { ...(metadata ?? {}), [MARKET_SOURCE_KEY]: source };
}

/** Read the source-link off a metadata bag, or null when absent/malformed. */
export function readMarketSource(
  metadata: Record<string, unknown> | null | undefined
): MarketSource | null {
  const raw = metadata?.[MARKET_SOURCE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<MarketSource>;
  if (
    typeof s.packageSlug !== "string" ||
    typeof s.baseline !== "object" ||
    s.baseline === null
  ) {
    return null;
  }
  return {
    packageSlug: s.packageSlug,
    packageVersion:
      typeof s.packageVersion === "string" ? s.packageVersion : null,
    installedAt: typeof s.installedAt === "string" ? s.installedAt : "",
    baseline: s.baseline as Record<string, unknown>,
  };
}

/**
 * DETACH — sever the source-link so the config stops reconciling. Returns the
 * metadata bag without its `marketSource` key (every other key preserved).
 */
export function detachMarketSource(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const bag = { ...(metadata ?? {}) };
  delete bag[MARKET_SOURCE_KEY];
  return bag;
}

export interface ThreeWayMergeResult {
  /** The field values to WRITE to the row: baseline-untouched fields advanced to
   *  the template's `desired`, owner-owned fields left at their live value. Only
   *  the keys reconcile manages appear here. */
  merged: Record<string, unknown>;
  /** Field names updated from the template (were untouched since install). */
  applied: string[];
  /** Field names the user edited since install — LEFT ALONE, never overwritten. */
  ownerOwned: string[];
  /** The `baseline` to persist next: applied fields advance to `desired`;
   *  owner-owned fields KEEP the old base (so their divergence stays detected —
   *  a later revert to base correctly re-enables reconcile). */
  nextBaseline: Record<string, unknown>;
  /** True when at least one field changed (`applied` non-empty) — the caller
   *  only writes the row when something actually moved. */
  changed: boolean;
}

/**
 * Per-field 3-way merge with owner-ownership. Reconcile the row's managed fields
 * toward `desired` (the template) without clobbering user edits.
 *
 * Scope = the keys the template currently manages (`Object.keys(desired)`), unioned
 * with the recorded baseline so a field the template DROPPED still reports its
 * ownership state (prune is OFF — dropped fields are never deleted, just no longer
 * advanced).
 *
 * Per field `k`:
 *   • base absent (template added `k` after install, we never wrote it): apply
 *     `desired[k]` ONLY if the row has no diverging value (`live[k]` absent or
 *     already equal to desired). If `live[k]` holds a different, user-supplied
 *     value, it is OWNER-OWNED — we never stomp a pre-existing value we didn't set.
 *   • base present, `live` deep-equals `base` (untouched since we wrote it): apply
 *     `desired[k]`.
 *   • base present, `live` diverges from `base` (user edited): OWNER-OWNED, skip.
 */
export function threeWayMergeFields(
  live: Record<string, unknown>,
  base: Record<string, unknown>,
  desired: Record<string, unknown>
): ThreeWayMergeResult {
  const merged: Record<string, unknown> = {};
  const applied: string[] = [];
  const ownerOwned: string[] = [];
  const nextBaseline: Record<string, unknown> = { ...base };

  const keys = new Set([...Object.keys(desired), ...Object.keys(base)]);

  for (const k of keys) {
    const hasDesired = Object.prototype.hasOwnProperty.call(desired, k);
    const hasBase = Object.prototype.hasOwnProperty.call(base, k);
    const liveVal = live[k];

    // Template dropped this field (prune OFF): leave the live value, keep the old
    // base, don't report it as a change.
    if (!hasDesired) {
      merged[k] = liveVal;
      continue;
    }

    const desiredVal = desired[k];

    if (!hasBase) {
      // Newly-managed field. Adopt it only when there's no diverging user value.
      if (liveVal === undefined || deepEqual(liveVal, desiredVal)) {
        merged[k] = desiredVal;
        nextBaseline[k] = jsonClone(desiredVal);
        if (!deepEqual(liveVal, desiredVal)) applied.push(k);
      } else {
        merged[k] = liveVal; // pre-existing user value — do not stomp
        ownerOwned.push(k);
      }
      continue;
    }

    const baseVal = base[k];
    if (deepEqual(liveVal, baseVal)) {
      // Untouched since we wrote it → advance to the template's value.
      merged[k] = desiredVal;
      nextBaseline[k] = jsonClone(desiredVal);
      if (!deepEqual(baseVal, desiredVal)) applied.push(k);
    } else {
      // User edited it → owner-owned. Leave live, keep the old base so the
      // divergence stays detected on the next pass.
      merged[k] = liveVal;
      ownerOwned.push(k);
    }
  }

  return {
    merged,
    applied,
    ownerOwned,
    nextBaseline,
    changed: applied.length > 0,
  };
}
