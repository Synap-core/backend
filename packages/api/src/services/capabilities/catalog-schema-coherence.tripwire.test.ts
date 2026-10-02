import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_VERB_PARAM_SCHEMAS } from "./builtin-verbs.js";
import { SYNAP_CORE_DEFINITION } from "./ensure-synap-core.js";

/**
 * TRIPWIRE — the builtin verb catalog is coherent with the handler contract.
 *
 * A verb's param contract lives in TWO places: the Zod schema the handler parses
 * (builtin-verbs.ts) and the JSON-schema advertised in the shipped catalog the
 * pod serves (`ensure-synap-core.ts`, consumed by list_capabilities).
 * Historically these drifted silently — a param added to the Zod schema but not
 * the catalog is accepted by the handler yet UNDISCOVERABLE (this bit
 * channel.resolve.branchPurpose, channel.create.metadata, feed.post.metadata,
 * output.generate.options).
 *
 * This asserts: every param the handler accepts (Zod key) is advertised in the
 * catalog that ships that verb, AND that exactly ONE catalog advertises it.
 *
 * ── WHY MORE THAN ONE CATALOG ───────────────────────────────────────────────
 * The pod's first-party builtins ship from an IN-REPO constant
 * (`SYNAP_CORE_DEFINITION`, boot-seeded). A MARKETPLACE capability ships as a
 * `category:"capability"` package in the Control-Plane catalog instead — its
 * param contract is the package definition, while any builtin handlers still
 * register in the SAME `BUILTIN_VERBS` map. So the invariant
 * "registered ⇒ advertised somewhere discoverable" has to sweep every shipped
 * definition, not just the in-repo one.
 *
 * The sweep is DERIVED from the shipped files, not hand-listed: every
 * `*.capability.json` under `templates/capabilities/` is read, so a capability
 * definition added to this repo joins the scan BY EXISTING. A hand-written list
 * would silently go stale the way a previous revision did — it named
 * `posthog-analytics.capability.json` after that definition moved to the
 * Control Plane catalog, leaving this file importing a path that no longer
 * exists and the whole tripwire failing to load (guarding nothing).
 *
 * The `exactly one catalog` rule keeps the widening honest: a verb declared in
 * two catalogs would satisfy the param check while shipping two competing rows.
 *
 * If it fails for a verb, advertise the missing param in ITS catalog's skill
 * `parameters.properties` — the boot reconciler / package re-apply self-heals
 * the row from there.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The marketplace capability definitions shipped from this repo, DERIVED by
 * globbing `templates/capabilities/`. The directory is absent when this repo
 * ships none (all marketplace definitions live in the Control Plane) — that is
 * a legitimate state, not a scan failure, so it yields an empty list.
 */
function readPublishedCapabilityFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".capability.json"))
    .sort()
    .map((name) => join(dir, name));
}

const PUBLISHED_CAPABILITY_FILES = readPublishedCapabilityFiles(
  join(HERE, "../../../../../templates/capabilities")
);

interface CatalogSource {
  /** Where the definition came from — named in every failure message. */
  label: string;
  /** verbId → the top-level param names its `parameters.properties` advertises. */
  params: Map<string, Set<string>>;
}

function readCatalog(label: string, definition: unknown): CatalogSource {
  const skills = (definition as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) {
    throw new Error(
      `${label}: no skills[] array — the coherence tripwire cannot sweep a catalog it cannot parse.`
    );
  }
  const params = new Map<string, Set<string>>();
  for (const skill of skills) {
    const name = (skill as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const properties =
      (skill as { parameters?: { properties?: Record<string, unknown> } })
        ?.parameters?.properties ?? {};
    params.set(name, new Set(Object.keys(properties)));
  }
  return { label, params };
}

const CATALOGS: CatalogSource[] = [
  readCatalog(
    "ensure-synap-core.ts (SYNAP_CORE_DEFINITION)",
    SYNAP_CORE_DEFINITION
  ),
  // A missing/unparseable file FAILS rather than silently narrowing the sweep: a
  // catalog that quietly slipped out of the scan would make this guard vacuous
  // for its verbs.
  ...PUBLISHED_CAPABILITY_FILES.map((file) =>
    readCatalog(file, JSON.parse(readFileSync(file, "utf8")) as unknown)
  ),
];

/** verbId → the catalogs that advertise it. */
const advertisingCatalogs = new Map<string, CatalogSource[]>();
for (const catalog of CATALOGS) {
  for (const verb of catalog.params.keys()) {
    const list = advertisingCatalogs.get(verb) ?? [];
    list.push(catalog);
    advertisingCatalogs.set(verb, list);
  }
}

describe("tripwire: builtin verb catalog advertises every handler param", () => {
  it("sweeps the in-repo catalog, and the sweep can still see what it hunts", () => {
    // A sweep over zero parsed skills is green and guards nothing. The in-repo
    // definition is the one that MUST be present; published capability
    // definitions are derived by globbing, so their count is whatever ships.
    expect(CATALOGS.length).toBeGreaterThanOrEqual(1);
    expect([...CATALOGS[0]!.params.keys()].length).toBeGreaterThan(10);

    // The derived set must agree with what is actually on disk — a glob that
    // silently stopped matching (moved directory, wrong depth) would narrow the
    // sweep to nothing and leave this guard vacuous.
    const expectedPublished = existsSync(
      join(HERE, "../../../../../templates/capabilities")
    )
      ? readdirSync(join(HERE, "../../../../../templates/capabilities")).filter(
          (n) => n.endsWith(".capability.json")
        ).length
      : 0;
    expect(PUBLISHED_CAPABILITY_FILES.length).toBe(expectedPublished);
  });

  for (const [verb, schema] of Object.entries(BUILTIN_VERB_PARAM_SCHEMAS)) {
    it(`${verb}: every Zod param is advertised in exactly one shipped catalog`, () => {
      const advertisers = advertisingCatalogs.get(verb) ?? [];
      expect(
        advertisers.length,
        `${verb} is in BUILTIN_VERB_PARAM_SCHEMAS but missing from every shipped catalog definition (${CATALOGS.map((c) => c.label).join(", ")})`
      ).toBeGreaterThan(0);
      expect(
        advertisers.map((c) => c.label),
        `${verb} is advertised in MORE THAN ONE shipped catalog — declare it in the one that ships it.`
      ).toHaveLength(1);

      const advertised = advertisers[0]!.params.get(verb)!;
      const zodKeys = Object.keys(schema.shape);
      const missing = zodKeys.filter((k) => !advertised.has(k));
      expect(
        missing,
        `${verb} handler accepts param(s) the catalog does not advertise (undiscoverable): ${missing.join(", ")}`
      ).toEqual([]);
    });
  }
});
