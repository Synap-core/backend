/**
 * Capability drift detection — shared by `ensureSynapCoreCapability` (the
 * first-party synap-core convergence guard) and the general
 * `reconcileCapabilitiesToTemplates` boot-time reconcile (apps/api/src/startup).
 *
 * A capability's canonical state lives in its `CapabilityDefinition.skills[]`
 * (code-owned / template-owned). "Drift" = a seeded skill whose live row no
 * longer matches the definition on any of the fields the applier actually
 * projects: `providerSpec`, `parameters`, `code`, `description`. Comparing only
 * `parameters` (the old ensure-synap-core guard) missed a definition change to
 * e.g. a declarative skill's `providerSpec.baseUrlOverride` — exactly the class
 * of fix (the `calendar_list` baseUrlOverride correction) this generalization
 * exists to catch.
 */

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

/** The subset of a live `skills` row the drift check reads. */
export interface InstalledSkillRow {
  name: string;
  providerSpec?: unknown;
  parameters?: unknown;
  code?: string | null;
  description?: string | null;
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
}

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
    const differs =
      canonicalJson(installed.providerSpec ?? null) !==
        canonicalJson(skill.providerSpec ?? null) ||
      canonicalJson(installed.parameters ?? {}) !==
        canonicalJson(skill.parameters ?? {}) ||
      canonicalJson(installed.code ?? null) !==
        canonicalJson(skill.code ?? null) ||
      canonicalJson(installed.description ?? null) !==
        canonicalJson(skill.description ?? null);
    if (differs) drifted.push(skill.name);
  }

  return { missing, drifted };
}
