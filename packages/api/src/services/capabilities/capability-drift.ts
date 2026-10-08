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
 * `ToolVerbCatalogEntry.intent` — the routing axis — was ORIGINALLY the only
 * place it landed. A field that lives only there is invisible to a `skills`-row
 * diff, so a template change touching only it reported NO drift while the
 * reconcile went on to stamp the new `contentHash` — recording convergence it
 * never performed and permanently fast-pathing past the miss. That is why
 * `intent` is now a real `skills.intent` COLUMN (`PROJECTED_SKILL_FIELDS`,
 * migration 0292) rather than a `metadata` key: the catalog mirror is derived,
 * the column is the authority, and the column is visible to this diff.
 * `capabilityVerbCatalogDrift` closes the remaining half; see
 * `PROJECTED_SKILL_FIELDS`' note on why both halves are pinned by a tripwire.
 */

import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import { paramPlaceholderTokens } from "../_shared/interpolate.js";

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
 * v8 = v7 + the reconcile's install-time-param gate reads EVERY projected field
 *      (`installTimePlaceholders`: skill code/description/parameters/…, tool
 *      config/metadata/description), not skill names alone. The comparator's
 *      field set is unchanged; what changed is what a v7 stamp could rest on: a
 *      template whose code (or tool config) baked a `{{param}}` behind plain
 *      skill names was re-applied with `{}` — the code blanked — and then
 *      STAMPED converged. That stamp asserted a convergence the comparator
 *      never agreed with (raw `{{x}}` ≠ blank). Retiring v7 stamps makes each
 *      container re-diff once, and such a container now surfaces as a manual
 *      re-apply instead of hiding behind its stamp.
 * v7 = v6 + the skill-row `intent` COLUMN as its own `PROJECTED_SKILL_FIELDS`
 *      entry (migration 0292). v6 compared intent as a `skills.metadata` KEY;
 *      that was a second writer beside `deriveToolVerbs` and it is gone, so the
 *      comparator now reads a real column. The bump is load-bearing for the same
 *      reason every bump here is: a v6 stamp says "clean under a comparator that
 *      looked somewhere this one does not", so honouring it would assert
 *      convergence about the new column that was never checked. Retiring every
 *      v6 stamp makes each container re-diff exactly once under v7.
 * v6 = v5 + the skill-row `intent` as a `skills.metadata` KEY. Superseded by v7
 *      — retained in this history because a v6 stamp on disk is exactly what
 *      makes the bump necessary, not noise to be edited away.
 * v5 = v4 + `metadata.readOnly` (the AUTHORED read-only declaration the
 *      capability gate honours — see `SKILL_METADATA_READ_ONLY`). Adding it
 *      retires every v4 stamp so each container re-diffs once and a declared
 *      read verb actually stops proposing on every call.
 * v4 = v3 + the tool row's merged JSONB (`PROJECTED_TOOL_MERGE_FIELDS`: config,
 *      metadata) via `capabilityToolMergeDrift`. Before it, a template change
 *      touching only `tools[].metadata` (nango-google's `metadata.sync`
 *      defaults) diffed clean, got stamped, and reached no installed pod.
 * v3 = v2 + `metadata.allowedHosts` (the sandbox egress declaration — see
 *      `declaredAllowedHosts`). Adding it retires every v2 stamp so each
 *      container re-diffs once and a declared allowlist actually lands.
 * v2 = the ten `PROJECTED_SKILL_FIELDS` + the projected verb catalog (intent).
 * v1 (never written) = the original providerSpec/parameters/code/description.
 */
export const DRIFT_COMPARATOR_VERSION = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * Deep-merge a template's default `metadata`/`config` UNDER the tool's existing
 * runtime values — existing wins at every leaf, the template only supplies keys the
 * tool does not already have. Preserves operator runtime state (e.g. the Discord
 * bot's `metadata.discord` channel links) across a boot-time template reconcile that
 * would otherwise reset it to the template's empty defaults. Arrays are treated as
 * leaves (existing replaces, never concatenated).
 *
 * Lives HERE (not in the applier) so the drift comparator computes tool-row
 * drift with the applier's exact merge — `create-from-definition.ts` imports it.
 */
export function mergePreservingExisting(
  template: Record<string, unknown>,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...template };
  for (const key of Object.keys(existing)) {
    const ev = existing[key];
    out[key] =
      key in template && isPlainObject(template[key]) && isPlainObject(ev)
        ? mergePreservingExisting(
            template[key] as Record<string, unknown>,
            ev as Record<string, unknown>
          )
        : ev; // existing leaf (incl. arrays / empty-string) wins
  }
  return out;
}

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
  /** The live row's `skills.intent` column — see the entry in
   *  `PROJECTED_SKILL_FIELDS`. */
  intent?: string | null;
  /** The live row's `skills.metadata` bag. Only its `allowedHosts` and `readOnly`
   *  keys are definition-owned; every other key is DB state (see
   *  the `SKILL_METADATA_*` constants). */
  metadata?: Record<string, unknown> | null;
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
  /** The definition's `metadata` bag — see `declaredAllowedHosts` and
   *  `declaredReadOnly`. */
  metadata?: Record<string, unknown> | null;
  /**
   * The definition skill's TOP-LEVEL routing intent, projected onto the REAL
   * `skills.intent` column (migration 0292) — not into the `metadata` bag,
   * which never carried it. Templates declare it beside `metadata` (`gmail_send`
   * has no `metadata` key at all), so reading it out of the bag would find
   * nothing on every real template.
   */
  intent?: string | null;
}

/**
 * The FIRST of the two keys of a `skills.metadata` bag that a capability
 * definition owns (the other is `SKILL_METADATA_READ_ONLY`, just below).
 *
 * `metadata` is otherwise DB state — `marketSource` (the standalone-config
 * reconcile's install baseline), `rule`, `skillType`, execution counters — and
 * the applier deliberately does not touch it. But ONE key inside it is the
 * thing the sandbox actually enforces: `run-skill-in-sandbox.ts` reads
 * `skill.metadata?.allowedHosts ?? []` and `host.fetch` refuses every host not
 * on that list (default-deny, SSRF-checked, redirects rejected).
 *
 * Until this existed the list had NO writer reachable from a package: the
 * applier passed no `metadata` at all, so a published third-party skill could
 * never grant itself egress to its own vendor's API — it installed cleanly and
 * died at run with `domain_not_approved`. Threading exactly this one key (and
 * nothing else) is what makes the existing gate usable without turning the
 * whole DB-owned bag into template-owned state.
 */
export const SKILL_METADATA_ALLOWED_HOSTS = "allowedHosts";

/**
 * The SECOND definition-owned key of a `skills.metadata` bag: the verb's
 * AUTHORED read-only declaration.
 *
 * WHY IT IS AUTHORED AND NOT DERIVED. `ToolVerbCatalogEntry.kind`
 * ("read" | "write" | "action") already exists, but it is a GUESS —
 * `deriveVerbKind()` classifies whole-word tokens of the verb's NAME and
 * DESCRIPTION and falls back to "action" for anything it cannot read. That is
 * fine for a DISPLAY axis (which is all it has ever been: the actions-door
 * projection and the intent index). It is NOT fine as an AUTHORIZATION axis:
 * honouring it at the gate would mean any future verb whose name happens to
 * contain "search" or "find" auto-runs ungoverned, and a mis-named mutating
 * verb would widen the auto path by accident. A naming convention must never
 * be a permission.
 *
 * So the gate honours ONLY this explicit declaration. `deriveVerbKind` stays
 * display-only and is deliberately NOT consulted by `execute-capability.ts`.
 *
 * WHAT IT BUYS. `exa_search` is a read with no side effects, but it is an HTTP
 * POST, and the provider path classified reads by HTTP METHOD
 * (`execute-provider-verb.ts`: `/^(GET|HEAD)$/`). So every search stalled on a
 * proposal and an unattended research loop could not proceed at all. A verb
 * that DECLARES `metadata.readOnly: true` is marked `readOnly` at the gate and
 * returns `run` before any grant rung — the same short-circuit builtin read
 * verbs already get via `READ_ONLY_BUILTIN_VERBS`.
 *
 * TRUST. Same boundary as `allowedHosts`: the declaration is disclosed on the
 * install/proposal card and WIDENING it (false/absent → true) on an
 * already-approved skill demotes that skill back to unapproved, exactly like
 * `allowedHostsChanged`. An approved verb can never become auto-running
 * without re-earning approval.
 */
export const SKILL_METADATA_READ_ONLY = "readOnly";

/*
 * THERE IS NO THIRD `skills.metadata` KEY. The routing intent used to be one —
 * `SKILL_METADATA_INTENT = "intent"` — and was removed in favour of a REAL
 * COLUMN, `skills.intent` (migration 0292). It is worth saying why, because the
 * reason is not "the column is nicer":
 *
 *   The metadata path was a WORKAROUND for the fact that `intent` lived only on
 *   the requiring TOOL's verb catalog, and a definition declaring `tools: []`
 *   (all of Synap Core's 47 builtins) had no such tool — so `messaging.send` was
 *   unroutable by intent while installed and runnable. Folding the value into
 *   the DB-owned `metadata` bag fixed reachability but created a SECOND WRITER
 *   beside `deriveToolVerbs`, i.e. the two-writers defect this codebase keeps
 *   paying for, with neither able to see the other.
 *
 *   A column has one writer by construction: the applier's `resolveVerbIntent`.
 *   `metadata` keeps exactly the two keys that are genuinely bag-shaped
 *   (`allowedHosts`, `readOnly`) and nothing else.
 */

/**
 * The egress allowlist a definition DECLARES, or `undefined` when it declares
 * none.
 *
 * `undefined` is load-bearing in both directions:
 * - to `projectSkillMetadata`: write nothing, leave the live bag alone;
 * - to `PROJECTED_SKILL_FIELDS.metadata.expected`: nothing to converge to, so
 *   the comparator skips the field (the same rule `category`/`agentTypes` use).
 *
 * So a template that omits the key does NOT revoke a list set through the
 * tRPC door — honest under-convergence, and nothing stamps otherwise. A
 * template that NARROWS or WIDENS the list does converge, and widening it under
 * an existing approval demotes the row (`allowedHostsChanged`).
 *
 * A non-array declaration is ignored rather than persisted: the sandbox calls
 * `.includes()` on it, and a string would silently allowlist by substring.
 */
export function declaredAllowedHosts(
  metadata: Record<string, unknown> | null | undefined
): string[] | undefined {
  const raw = (metadata ?? {})[SKILL_METADATA_ALLOWED_HOSTS];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((h): h is string => typeof h === "string");
}

/**
 * The read-only posture a definition DECLARES, or `undefined` when it declares
 * none. Same `undefined`-is-load-bearing contract as `declaredAllowedHosts`:
 * absent → the applier writes nothing and the comparator skips the field, so a
 * template that omits the key does NOT revoke a posture set elsewhere.
 *
 * A NON-BOOLEAN declaration is ignored rather than coerced. `"false"`,
 * `0` and `"no"` are all truthy-or-falsy in ways that differ from what the
 * author meant, and this value gates an auto-execute path — the one place a
 * lenient parse is never worth it. Only a real `true`/`false` is honoured.
 */
export function declaredReadOnly(
  metadata: Record<string, unknown> | null | undefined
): boolean | undefined {
  const raw = (metadata ?? {})[SKILL_METADATA_READ_ONLY];
  return typeof raw === "boolean" ? raw : undefined;
}

/**
 * THE applier's `skills.metadata` projection — the single expression the
 * template applier's `.set({ metadata: ... })` uses, and the one the drift
 * comparator is derived from.
 *
 * Contract, pinned by `capability-drift.projection-parity.tripwire.test.ts`:
 * every key of the live bag is preserved byte-identically and ONLY the
 * definition-owned keys (`allowedHosts`, `readOnly`) are ever written. That is
 * what lets `PROJECTED_SKILL_FIELDS` carry a `metadata` entry that reads just
 * those keys without the stamp overclaiming: the marker asserts exactly what
 * the comparator checked.
 *
 * Each key is INDEPENDENTLY skippable — a template declaring only `readOnly`
 * must not blank an `allowedHosts` list set through the tRPC door, and vice
 * versa. Returns `undefined` only when the definition declares NEITHER, so
 * Drizzle's `.set()` skips the key and the live bag is not rewritten at all.
 */
export function projectSkillMetadata(
  existing: Record<string, unknown> | null | undefined,
  definitionMetadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const hosts = declaredAllowedHosts(definitionMetadata);
  const readOnly = declaredReadOnly(definitionMetadata);
  if (hosts === undefined && readOnly === undefined) {
    return undefined;
  }
  return {
    ...((existing ?? {}) as Record<string, unknown>),
    ...(hosts !== undefined ? { [SKILL_METADATA_ALLOWED_HOSTS]: hosts } : {}),
    ...(readOnly !== undefined ? { [SKILL_METADATA_READ_ONLY]: readOnly } : {}),
  };
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
    /**
     * `def` is passed so an entry NARROWED to a subset of keys can read the
     * SAME subset on both sides. Only `metadata` needs it: its keys are
     * INDEPENDENTLY declarable, and a key the definition omits is not written
     * by the applier — so including the live value for that key would report
     * drift a re-apply can never converge, i.e. a re-apply on every boot.
     * Every other entry ignores it.
     */
    actual: (installed: InstalledSkillRow, def: DefinitionSkillRow) => unknown;
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
  /**
   * THE ROUTING INTENT, as its own COLUMN entry rather than a metadata key.
   *
   * It used to ride inside the `metadata` bag (a second writer beside
   * `deriveToolVerbs`); it is now the real `skills.intent` column written by the
   * applier's `resolveVerbIntent`, and it therefore belongs in this table like
   * every other projected column — a table that skipped it would stamp the
   * template converged while a changed intent reached no pod, which is the exact
   * durable lie `DRIFT_COMPARATOR_VERSION` exists to retire.
   *
   * Same `undefined`-is-load-bearing rule as `category`/`agentTypes`: a
   * definition that declares NO intent makes the applier skip the column, so
   * there is nothing to converge to and comparing would report drift a re-apply
   * never fixes — a re-apply on every boot. A definition that DOES declare one
   * converges, and a row missing it reads `null`, which is the drift signal.
   */
  intent: {
    expected: (d) =>
      typeof d.intent === "string" && d.intent.length > 0
        ? d.intent
        : undefined,
    // Declared-ness is decided on the DEFINITION side, exactly as `metadata`
    // does for its independently-declarable keys: a template that declares no
    // `intent` must not diff against (or blank) one set by another definition.
    // Missing on a DECLARED key reads `null`, which is the drift signal —
    // dropping this read would make the column invisible here and the stamp
    // would overclaim.
    actual: (i, d) =>
      typeof d.intent === "string" && d.intent.length > 0
        ? (i.intent ?? null)
        : undefined,
  },
  // NARROWED ON PURPOSE. The applier's `.set({ metadata })` writes exactly the
  // definition-owned keys of this bag (`projectSkillMetadata` above); every
  // other key is DB-owned and preserved. So this entry reads exactly those keys —
  // comparing the whole bag would report drift on `marketSource`/counters the
  // template never owns, i.e. a re-apply on every boot. Marker coverage ==
  // applier coverage.
  metadata: {
    expected: (d) => {
      const hosts = declaredAllowedHosts(d.metadata);
      const readOnly = declaredReadOnly(d.metadata);
      // ALL absent → the applier writes nothing, so there is nothing to
      // converge to and the field is skipped (the shared rule above).
      if (hosts === undefined && readOnly === undefined) {
        return undefined;
      }
      // Only the DECLARED keys are present. A key the definition omits is not
      // written by the applier, so it must not appear on either side.
      return {
        ...(hosts !== undefined
          ? { [SKILL_METADATA_ALLOWED_HOSTS]: hosts }
          : {}),
        ...(readOnly !== undefined
          ? { [SKILL_METADATA_READ_ONLY]: readOnly }
          : {}),
      };
    },
    // Mirrors `expected`'s key set EXACTLY — driven by what the DEFINITION
    // declares, never by what the live bag happens to hold. A template that
    // declares only `readOnly` must not blank (or diff against) an
    // `allowedHosts` list set through the tRPC door.
    actual: (i, d) => {
      const hosts =
        declaredAllowedHosts(d.metadata) === undefined
          ? undefined
          : (declaredAllowedHosts(i.metadata) ?? null);
      const readOnly =
        declaredReadOnly(d.metadata) === undefined
          ? undefined
          : (declaredReadOnly(i.metadata) ?? null);
      if (hosts === undefined && readOnly === undefined) {
        return undefined;
      }
      return {
        ...(hosts !== undefined
          ? { [SKILL_METADATA_ALLOWED_HOSTS]: hosts }
          : {}),
        ...(readOnly !== undefined
          ? { [SKILL_METADATA_READ_ONLY]: readOnly }
          : {}),
      };
    },
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
      return (
        canonicalJson(expected) !==
        canonicalJson(field.actual(installed, skill))
      );
    });
    if (differs) drifted.push(skill.name);
  }

  return { missing, drifted };
}

/** The subset of a live `tools` row the tool drift checks read. */
export interface InstalledToolRow {
  name: string;
  /** `tools.capabilities` — the stored verb catalog. */
  capabilityCatalog?: ToolVerbCatalogEntry[] | null;
  /** `tools.config` / `tools.metadata` — see `PROJECTED_TOOL_MERGE_FIELDS`. */
  config?: unknown;
  metadata?: unknown;
}

/**
 * The JSONB fields the applier deep-merges template-UNDER-existing onto an
 * EXISTING tool row (`create-from-definition.ts`, existing-tool `.set({...})`,
 * each via `mergePreservingExisting`). Derived from that block and pinned by
 * `capability-drift.projection-parity.tripwire.test.ts` — a new merged field
 * there without an entry here fails the tripwire by name.
 */
export const PROJECTED_TOOL_MERGE_FIELDS = ["config", "metadata"] as const;

/** The subset of a definition tool the merge drift check reads. */
export interface DefinitionToolRow {
  name?: unknown;
  config?: unknown;
  metadata?: unknown;
}

/**
 * Tool-row drift on the merged JSONB fields: a tool DRIFTS exactly when a
 * re-apply would change it, i.e. the template declares a key path the live row
 * lacks. Computed with the applier's OWN merge, so the diff and the convergence
 * cannot disagree:
 *   - after one apply every declared path exists and the merge is the identity,
 *     so a converged row never re-applies on the next boot;
 *   - a user override (an existing leaf that differs from the template) is
 *     never drift, because the merge keeps it;
 *   - runtime keys the template never declares (sync run state, watermarks)
 *     are never drift.
 */
export function capabilityToolMergeDrift(
  installedToolRows: InstalledToolRow[],
  declaredTools: DefinitionToolRow[]
): { drifted: string[] } {
  const installedByName = new Map(
    installedToolRows.map((row) => [row.name, row])
  );
  const drifted: string[] = [];
  for (const tool of declaredTools) {
    // Same skip as the skill / verb-catalog diffs: an interpolated name cannot
    // be matched exactly, and an absent tool is missingToolMemberships' concern.
    if (typeof tool.name !== "string" || tool.name.includes("{{")) continue;
    const installed = installedByName.get(tool.name);
    if (!installed) continue;
    const differs = PROJECTED_TOOL_MERGE_FIELDS.some((field) => {
      const template = tool[field];
      if (!isPlainObject(template)) return false;
      const live = isPlainObject(installed[field]) ? installed[field] : {};
      return (
        canonicalJson(mergePreservingExisting(template, live)) !==
        canonicalJson(live)
      );
    });
    if (differs) drifted.push(tool.name);
  }
  return { drifted };
}

/**
 * The ONE projected skill field whose `{{token}}`s are NOT install-time params:
 * a `providerSpec` holds RUNTIME verb arguments, and the applier restores it RAW
 * after interpolating the definition (`create-from-definition.ts`).
 * `PROJECTED_SKILL_FIELDS` is a `Record<string, …>`, so the type system cannot
 * tie this name to it — `capability-drift.test.ts` asserts it is a real key.
 */
export const RUNTIME_PLACEHOLDER_SKILL_FIELDS = ["providerSpec"] as const;

/**
 * Every tool field the applier writes from the INTERPOLATED definition: the
 * match-key `name`, the overwritten `description` (`applyTemplateToExistingTool`)
 * and the merged JSONB (`PROJECTED_TOOL_MERGE_FIELDS`, which a NEW tool row gets
 * whole). `credentialRef` is not here: its tokens are the credential guard's
 * (`requiredParamSecretsExist`), and `capabilities` is derived from the skills.
 */
export const PLACEHOLDER_CARRYING_TOOL_FIELDS = [
  "name",
  "description",
  ...PROJECTED_TOOL_MERGE_FIELDS,
] as const;

/**
 * WHERE a definition still carries an install-time `{{param}}` — on any field a
 * paramless (`{}`) re-apply would re-interpolate and write.
 *
 * The reconcile re-applies a drifted template with NO params, so every such
 * token becomes a blank (or a default) the installer never chose: an agent id
 * baked into code, a host in a tool's config. It used to look at skill NAMES
 * only, so a template whose names were plain but whose code baked a param
 * (unipile-linkedin's account id) was re-applied with `{}` — the code blanked,
 * an approved skill demoted, and the container stamped converged.
 *
 * The scanned set is DERIVED, never hand-listed: skill `name` + every
 * `PROJECTED_SKILL_FIELDS` key (pinned to the applier's own `.set({...})` by the
 * projection-parity tripwire) minus `RUNTIME_PLACEHOLDER_SKILL_FIELDS`; tools by
 * `PLACEHOLDER_CARRYING_TOOL_FIELDS`. Whole declared values are scanned (not the
 * update's narrowed projection), because a skill or tool MISSING from the pod is
 * CREATED with the whole value. `{{vault:<ref>}}` is not a param — it resolves
 * from the template's own vault on every apply.
 *
 * `vault[].value` / `credentialRef` tokens are deliberately out of scope: a
 * re-apply never needs them once the secret exists (`requiredParamSecretsExist`).
 */
export function installTimePlaceholders(definition: {
  skills?: ReadonlyArray<Record<string, unknown>>;
  tools?: ReadonlyArray<Record<string, unknown>>;
}): Array<{ where: string; tokens: string[] }> {
  const runtime = new Set<string>(RUNTIME_PLACEHOLDER_SKILL_FIELDS);
  const skillFields = [
    "name",
    ...Object.keys(PROJECTED_SKILL_FIELDS).filter((k) => !runtime.has(k)),
  ];
  const found: Array<{ where: string; tokens: string[] }> = [];
  const scan = (
    kind: "skill" | "tool",
    row: Record<string, unknown>,
    fields: readonly string[]
  ) => {
    for (const field of fields) {
      const tokens = paramPlaceholderTokens(row[field]);
      if (tokens.length > 0) {
        found.push({
          where: `${kind} "${String(row.name)}" ${field}`,
          tokens,
        });
      }
    }
  };
  for (const s of definition.skills ?? []) scan("skill", s, skillFields);
  for (const t of definition.tools ?? [])
    scan("tool", t, PLACEHOLDER_CARRYING_TOOL_FIELDS);
  return found;
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
