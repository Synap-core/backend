/**
 * Capability drift detection — shared by `ensureSynapCoreCapability` (the
 * first-party synap-core convergence guard) and the general
 * `reconcileCapabilitiesToTemplates` boot-time reconcile (apps/api/src/startup).
 *
 * A capability's canonical state lives in its `CapabilityDefinition.skills[]`
 * (code-owned / template-owned). "Drift" = a seeded skill whose live row no
 * longer matches the definition on any of the fields the applier actually
 * projects — enumerated ONCE in `PROJECTED_SKILL_FIELDS` below. Comparing only
 * `parameters` (the old ensure-synap-core guard) missed a definition change to
 * e.g. a declarative skill's `providerSpec.baseUrlOverride` — exactly the class
 * of fix (the `calendar_list` baseUrlOverride correction) this generalization
 * exists to catch.
 *
 * A definition skill also projects onto a SECOND surface: the requiring tool's
 * `tools.capabilities` verb catalog (`deriveToolVerbs`), which is where
 * `ToolVerbCatalogEntry.intent` — the routing axis — actually lands. A field
 * that lives only there (intent did) is invisible to a `skills`-row diff, so a
 * template change touching only it reported NO drift while the reconcile went
 * on to stamp the new `contentHash` — recording convergence it never performed
 * and permanently fast-pathing past the miss. `capabilityVerbCatalogDrift`
 * closes that half; see `PROJECTED_SKILL_FIELDS`' note on why both halves are
 * pinned by a tripwire.
 */

import type { ToolVerbCatalogEntry } from "@synap/database/schema";

/** Canonical (key-sorted) JSON — jsonb does not preserve key insertion order, so a
 * plain JSON.stringify would report false drift on key order alone. Normalizes
 * `undefined`/absent to `null` so both sides compare the same "nothing here". */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(sort(value ?? null));
}

/**
 * COVERAGE VERSION of this comparator — bump it whenever the set of fields the
 * comparator reads changes (`PROJECTED_SKILL_FIELDS`, or the verb-catalog half).
 *
 * WHY A VERSION EXISTS. `reconcileCapabilitiesToTemplates` stamps a converged
 * container with the template's `contentHash` and then fast-paths past any
 * container whose stored hash still matches. That stamp is only as trustworthy
 * as the comparator that cleared it: when `intent` was added to the template
 * shape, the four-field comparator saw no drift, the reconcile stamped the new
 * hash anyway, and the fast path then skipped the container forever — a miss
 * that was both permanent and self-certifying. Pairing the hash with the
 * comparator version makes the stamp mean "diff-clean under comparator vN", so
 * teaching the comparator a new field invalidates every stamp it ever wrote and
 * every pod re-diffs exactly once. Absent (legacy) = pre-versioned = re-diff.
 *
 * v2 = the ten `PROJECTED_SKILL_FIELDS` + the projected verb catalog (intent).
 * v1 (never written) = the original providerSpec/parameters/code/description.
 */
export const DRIFT_COMPARATOR_VERSION = 2;

/** The subset of a live `skills` row the drift check reads. */
export interface InstalledSkillRow {
  name: string;
  providerSpec?: unknown;
  parameters?: unknown;
  code?: string | null;
  description?: string | null;
  kind?: string | null;
  scope?: string | null;
  category?: string | null;
  agentTypes?: string[] | null;
  executionMode?: string | null;
  timeoutSeconds?: number | null;
}

/** The subset of a `CapabilitySkillDef` the drift check reads. */
export interface DefinitionSkillRow {
  name: string;
  providerSpec?: unknown;
  parameters?: unknown;
  // Nullable-symmetric with InstalledSkillRow — the drift check compares the two
  // and normalizes null/undefined (canonicalJson), so both rows accept null.
  code?: string | null;
  description?: string | null;
  kind?: string | null;
  scope?: string | null;
  category?: string | null;
  agentTypes?: string[] | null;
  executionMode?: string | null;
  timeoutSeconds?: number | null;
}

/**
 * ONE table naming every definition-owned field the applier writes onto a live
 * `skills` row, and how to read each side of the comparison.
 *
 * WHY A TABLE AND NOT AN INLINE `||` CHAIN: the chain compared four fields while
 * the applier projected ten, so `kind`/`scope`/`category`/`agentTypes`/
 * `executionMode`/`timeoutSeconds` could each change in a template and reach no
 * pod — silently, and (because reconcile then stamped the new `contentHash`)
 * permanently. A pinned table is greppable, countable, and tripwire-checkable
 * against the applier's own `.set({...})`; a chain is none of those.
 *
 * `expected` returns the value the applier WILL write. Returning `undefined`
 * means it writes nothing at all — Drizzle's `.set()` SKIPS an undefined key, so
 * the live value is left untouched. Comparing such a field would report drift a
 * re-apply can never converge, which is a re-apply on every single boot; those
 * fields are skipped instead.
 *
 * `description` and `parameters` keep their original normalize-to-`null`/`{}`
 * shape rather than the skip rule — that is the pre-existing behaviour of this
 * comparator and is deliberately left alone here.
 */
export const PROJECTED_SKILL_FIELDS: Record<
  string,
  {
    expected: (def: DefinitionSkillRow) => unknown;
    actual: (installed: InstalledSkillRow) => unknown;
  }
> = {
  providerSpec: {
    expected: (d) => d.providerSpec ?? null,
    actual: (i) => i.providerSpec ?? null,
  },
  parameters: {
    expected: (d) => d.parameters ?? {},
    actual: (i) => i.parameters ?? {},
  },
  code: { expected: (d) => d.code ?? null, actual: (i) => i.code ?? null },
  description: {
    expected: (d) => d.description ?? null,
    actual: (i) => i.description ?? null,
  },
  // Defaulted by the applier (`s.kind ?? "code"` etc.) — the default IS written,
  // so an absent template value compares against it, never skips.
  kind: { expected: (d) => d.kind ?? "code", actual: (i) => i.kind ?? "code" },
  scope: { expected: (d) => d.scope ?? "pod", actual: (i) => i.scope ?? "pod" },
  executionMode: {
    expected: (d) => d.executionMode ?? "sync",
    actual: (i) => i.executionMode ?? "sync",
  },
  timeoutSeconds: {
    expected: (d) => d.timeoutSeconds ?? 30,
    actual: (i) => i.timeoutSeconds ?? 30,
  },
  // Written raw — an absent template value is a Drizzle no-op (see above).
  category: { expected: (d) => d.category, actual: (i) => i.category ?? null },
  agentTypes: {
    expected: (d) => d.agentTypes,
    actual: (i) => i.agentTypes ?? null,
  },
};

export interface CapabilityDriftResult {
  /** A definition skill with no matching installed row (by name) — needs seeding. */
  missing: string[];
  /** A definition skill present but whose projected fields differ — needs re-projection. */
  drifted: string[];
}

/**
 * Diff a definition's skills against the live installed rows (matched by
 * `name`). Read-only — callers decide whether/how to converge (re-apply via
 * the governed `createCapabilityFromDefinition`, never a raw update here).
 */
export function capabilityDefinitionDrift(
  installedSkillsRows: InstalledSkillRow[],
  definition: { skills: DefinitionSkillRow[] }
): CapabilityDriftResult {
  const installedByName = new Map(
    installedSkillsRows.map((row) => [row.name, row])
  );

  const missing: string[] = [];
  const drifted: string[] = [];

  for (const skill of definition.skills ?? []) {
    // A skill NAME carrying an unresolved `{{param}}` placeholder cannot be
    // matched by exact name against an installed row — the live row's name was
    // interpolated at install with params the reconcile doesn't have. Reporting
    // it as "missing" would make a boot reconcile re-project the template with
    // `{}` params and mint a junk skill named with a BLANK placeholder. Skip it;
    // parameterized-name templates are handled as "manual re-apply" upstream.
    // (Surfaced by dogfooding the team pod: generic-apikey's
    // `{{name}} fetch-and-propose`.)
    if (skill.name.includes("{{")) continue;
    const installed = installedByName.get(skill.name);
    if (!installed) {
      missing.push(skill.name);
      continue;
    }
    const differs = Object.values(PROJECTED_SKILL_FIELDS).some((field) => {
      const expected = field.expected(skill);
      // The applier writes nothing for this field — nothing to converge to.
      if (expected === undefined) return false;
      return canonicalJson(expected) !== canonicalJson(field.actual(installed));
    });
    if (differs) drifted.push(skill.name);
  }

  return { missing, drifted };
}

/** The subset of a live `tools` row the verb-catalog drift check reads. */
export interface InstalledToolRow {
  name: string;
  /** `tools.capabilities` — the stored verb catalog. */
  capabilityCatalog?: ToolVerbCatalogEntry[] | null;
}

/**
 * Diff a definition's PROJECTED verb catalog against what the live tool rows
 * carry (both matched by tool NAME, then by verb `id` inside).
 *
 * The projection is NOT recomputed here: the caller passes what
 * `deriveToolVerbs` — the one applier-side projection — produced, so the
 * comparator can never disagree with what a re-apply would write. Entries are
 * compared WHOLE (canonicalJson), so every field that projection emits, present
 * and future, is covered without editing this function; that is deliberately a
 * different shape from `PROJECTED_SKILL_FIELDS`, which cannot compare whole rows
 * because a live `skills` row also carries DB-owned state the template never
 * projects.
 *
 * SUBSET semantics, mirroring the applier's additive contract: a live verb the
 * template does not declare (e.g. one minted by `createDeclarativeVerb`) is NOT
 * drift. A tool the graph is missing entirely is `missingToolMemberships`'
 * concern, not this one — absent here means "nothing to compare", never drift.
 */
export function capabilityVerbCatalogDrift(
  installedToolRows: InstalledToolRow[],
  projectedVerbsByToolName: Map<string, ToolVerbCatalogEntry[]>
): { drifted: string[] } {
  const installedByName = new Map(
    installedToolRows.map((row) => [row.name, row])
  );
  const drifted: string[] = [];

  for (const [toolName, projected] of projectedVerbsByToolName) {
    // Same reason `capabilityDefinitionDrift` skips a templated skill name: the
    // live row's name was interpolated at install with params this diff has no
    // access to, so exact-name matching can never resolve it.
    if (toolName.includes("{{")) continue;
    const installed = installedByName.get(toolName);
    if (!installed) continue;
    const liveById = new Map(
      (installed.capabilityCatalog ?? []).map((v) => [v.id, v])
    );
    const differs = projected.some((verb) => {
      const live = liveById.get(verb.id);
      return !live || canonicalJson(live) !== canonicalJson(verb);
    });
    if (differs) drifted.push(toolName);
  }

  return { drifted };
}
