/**
 * TRIPWIRE — what the SCHEMA DOOR advertises for a profile row must be what the
 * WRITE VALIDATOR enforces for THAT SAME ROW, at THAT SAME LENS.
 *
 * ── Defect 1: values declared, populated by nobody (live pod, 2026-09-12) ───
 * `/api/hub/discover` documents `options` as "Valid values for select/enum
 * types" and read it from `constraints.options` ?? `uiHints.options`. The seed
 * writes `options: [` ZERO times and `enum: [` 27 times; `constraints.enum` is
 * also the only key `property-validation-service.ts` enforces. So 27 enforced
 * enums were emitted as unconstrained strings. A client's agent read
 * `decision`, wrote `status: "open"`, and was rejected by an enum it had never
 * been shown. Every key was DECLARED — which is why this file asserts VALUES
 * ARRIVE and then feeds them to the real validator.
 *
 * ── Defect 2: the right schema under the wrong row ─────────────────────────
 * The handler fetched each row's schema BY SLUG and cached it BY ID. With a
 * workspace twin outranking the system row at the workspace-less lens, the
 * system `knowledge` row was described with its twin's properties, under its
 * own id. Fixed by `resolveRowSchema` (discover.ts); guarded in the last block.
 *
 * ── How it crosses the seam ────────────────────────────────────────────────
 *   • defs are EXTRACTED from the seed's source (`_seed-property-defs.ts`);
 *   • the emitted shape is the REAL exported `toDiscoverProperty`;
 *   • acceptance comes from the REAL `PropertyValidationService`, through a
 *     stub resolution service that only returns the parsed defs;
 *   • enforcement is PROBED (a sentinel is rejected), never read off source.
 *
 * ── What this does NOT cover (measured, not implied) ───────────────────────
 *   • No HTTP handler, no database. `resolveRowSchema` is driven against a FAKE
 *     schema door that ENCODES the resolver's twin ordering and its stricter id
 *     path as they stand on 2026-09-12 (profile-repository.ts getBySlug,
 *     profile-resolution-service.ts isAccessible). If the real ordering
 *     changes, the fake does not follow; this proves discover's DECISION given
 *     that behaviour, not the behaviour itself.
 *   • The handler's use of both functions is a SOURCE SCAN; granularity is the
 *     file. It sees the calls named, not that they are reachable.
 *   • Seeded system defs at base scope only. Workspace overlays and
 *     template-installed profiles are out of reach of a source parse.
 *   • The `required` assertion proves the projection passes `required` through
 *     and that the validator enforces it; who POPULATES `required` (the
 *     resolution layer, from the profile↔property link) is not exercised.
 *   • It reads NO pod. Fossil links (a live `task` carrying both `status` and
 *     `task-status` because the seeder's link pass never unlinks) cannot turn
 *     it red: the fossil slugs are not in the seed source, and the assertions
 *     are per-def contracts, never "the seed is clean". Measured: `task-status`,
 *     `task-priority`, `task-due-date`, `task-project` → 0 hits in the seed.
 *   • DIST, NOT SRC. The normaliser is exercised through `@synap/database`'s
 *     BUILT output (`main`/`exports` → `./dist`), because that is the module
 *     instance `discover.ts` imports; importing `src` here would test a
 *     different module than the seam. Measured 2026-09-12: mutating
 *     `src/utils/property-presentation.ts` alone stayed GREEN (8/8); the same
 *     mutation in `dist/utils/property-presentation.js` went RED on exactly the
 *     enum test. So LOCALLY this file is only as fresh as the last database
 *     build — a regression can stay green and a correct fix can go red. The
 *     "not stale" block below makes the silent half LOUD by running src and
 *     dist side by side; it proves they AGREE (i.e. you rebuilt), never which
 *     one is right. CI, read from config (not from a CI run): `pnpm test` =
 *     `turbo run test`; turbo.json `test.dependsOn: ["build"]` →
 *     `@synap/api#build` → `^build` → `@synap/database#build`, so CI tests a
 *     fresh dist. The earlier explicit build step (ci.yml:114-129) swallows
 *     failures with `|| echo`, but a failed database build still fails the
 *     turbo test graph that depends on it.
 */

import { beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PropertyValidationService,
  resolvePropertyLabel as builtLabel,
  resolvePropertyOptions as builtOptions,
  type ProfileResolutionService,
  type EffectiveProperty,
} from "@synap/database";

import {
  resolveRowSchema,
  toDiscoverProperty,
  type RowSchemaFetchResult,
} from "../routers/hub-protocol/rest/discover.js";
import {
  ALL_LITERALS,
  ENUM_DEFS,
  SEED_ENUM_SITE_COUNT,
  SEEDED_DEFS,
  SEEDED_REQUIRED_LINKS,
  constraintsOf,
} from "./_seed-property-defs.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const DISCOVER_FILE = resolve(
  here,
  "..",
  "routers",
  "hub-protocol",
  "rest",
  "discover.ts"
);

// ── Drive the REAL validator with the extracted defs ───────────────────────

function validatorFor(
  defs: Record<string, unknown>[]
): PropertyValidationService {
  const effective = defs.map((d) => ({
    id: `def-${String(d.slug)}`,
    slug: String(d.slug),
    valueType: d.valueType,
    constraints: d.constraints ?? {},
    uiHints: d.uiHints ?? {},
    required: d.required === true,
    defaultValue: d.defaultValue ?? null,
    displayOrder: 0,
  })) as unknown as EffectiveProperty[];

  const resolution = {
    getEffectiveProperties: async () => effective,
  } as unknown as ProfileResolutionService;

  return new PropertyValidationService(resolution);
}

async function accepts(
  def: Record<string, unknown>,
  value: unknown
): Promise<boolean> {
  const result = await validatorFor([def]).validateProperties(
    { [String(def.slug)]: value },
    "profile-under-test",
    null,
    { enforceRequired: false }
  );
  return result.valid === true;
}

/** A value no seeded enum can plausibly contain. */
const SENTINEL = "__value_no_enum_contains__";

describe("discover schema door ⇄ write validator: enum parity", () => {
  it("the extractor actually reaches the seed (a vacuous green is the same false certificate)", () => {
    expect(ALL_LITERALS.length).toBeGreaterThan(0);
    expect(SEEDED_DEFS.length).toBeGreaterThan(0);
    expect(SEEDED_REQUIRED_LINKS.length).toBeGreaterThan(0);

    // DERIVED floor: two independent measurements of the enum population must
    // agree. The raw-text count cannot silently shrink when the parser starts
    // dropping a def (a spread, a call); the parsed count cannot be fooled by
    // prose. If they disagree, the scans below are watching a smaller set than
    // the seed actually enforces.
    expect(SEED_ENUM_SITE_COUNT).toBeGreaterThan(0);
    expect(
      ENUM_DEFS.length,
      `The seed text has ${SEED_ENUM_SITE_COUNT} \`enum: [\` sites but the parser ` +
        `extracted ${ENUM_DEFS.length} enum defs — a seed shape it cannot evaluate ` +
        `is being dropped from every assertion in this file.`
    ).toBe(SEED_ENUM_SITE_COUNT);

    // Self-check that the extractor still SEES a literal sample.
    const status = ENUM_DEFS.find((d) => d.slug === "status");
    expect(status, "the seed's `status` def was not extracted").toBeTruthy();
    expect(constraintsOf(status!).enum).toContain("in-progress");
  });

  it("every value the schema door ADVERTISES is a value the validator ACCEPTS", async () => {
    const violations: string[] = [];
    for (const def of ENUM_DEFS) {
      for (const option of toDiscoverProperty(def).options ?? []) {
        if (!(await accepts(def, option))) {
          violations.push(
            `${String(def.slug)} advertises "${option}" — rejected`
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every property the validator CLOSES, the schema door SHOWS the set for", async () => {
    // THE headline assertion, and the one the shipped bug failed.
    const invisible: string[] = [];
    let closedCount = 0;

    for (const def of SEEDED_DEFS) {
      if (await accepts(def, SENTINEL)) continue; // open set
      const constraints = constraintsOf(def);
      if (!Array.isArray(constraints.enum)) continue; // closed for another reason
      closedCount++;

      const emitted = toDiscoverProperty(def);
      if (!emitted.options || emitted.options.length === 0) {
        invisible.push(
          `${String(def.slug)}: validator enforces [${(constraints.enum as string[]).join(", ")}] but discover emits no \`options\``
        );
        continue;
      }
      const missing = (constraints.enum as string[]).filter(
        (v) => !emitted.options!.includes(v)
      );
      if (missing.length) {
        invisible.push(
          `${String(def.slug)}: validator accepts [${missing.join(", ")}] which discover never advertises`
        );
      }
    }

    // Non-vacuity, derived: every seeded enum must have been probed as closed.
    // The loop `continue`s on two conditions, either of which could empty it.
    expect(closedCount).toBe(SEED_ENUM_SITE_COUNT);
    expect(
      invisible,
      `An agent reading /discover cannot see values the write path enforces. ` +
        `This is the defect that made a client's agent write \`status: "open"\` ` +
        `to \`decision\` and be rejected by an enum it was never shown.\n` +
        invisible.join("\n")
    ).toEqual([]);
  });

  it("a value outside the set is rejected — so `options` is a real contract, not decoration", async () => {
    let probed = 0;
    for (const def of ENUM_DEFS) {
      expect(
        await accepts(def, SENTINEL),
        `${String(def.slug)} advertises a closed set the validator does not enforce`
      ).toBe(false);
      probed++;
    }
    expect(probed).toBe(SEED_ENUM_SITE_COUNT);
  });
});

describe("discover schema door ⇄ write validator: required + label parity", () => {
  it("every property the validator REQUIRES, the schema door marks `required: true`", async () => {
    const violations: string[] = [];
    let probed = 0;

    for (const link of SEEDED_REQUIRED_LINKS) {
      const def = SEEDED_DEFS.find((d) => d.slug === link.slug);
      if (!def) continue;
      const required = { ...def, required: true };

      // Probe enforcement: an empty write must fail.
      const result = await validatorFor([required]).validateProperties(
        {},
        "profile-under-test",
        null
      );
      if (result.valid) continue; // a default satisfies it
      probed++;

      if (toDiscoverProperty(required).required !== true) {
        violations.push(
          `${String(def.slug)}: write path rejects a create without it, discover does not mark it required`
        );
      }
    }

    expect(probed).toBeGreaterThan(0);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("labels reach the wire — the seeds write `uiHints.label`, and it must arrive", () => {
    const labelled = SEEDED_DEFS.filter(
      (d) =>
        typeof (d.uiHints as Record<string, unknown> | undefined)?.label ===
        "string"
    );
    expect(labelled.length).toBeGreaterThan(0);

    const rawSlug = labelled.filter(
      (d) =>
        toDiscoverProperty(d).displayName !==
        (d.uiHints as Record<string, string>).label.trim()
    );
    expect(
      rawSlug.map((d) => String(d.slug)),
      `These carry a human label in the seed that does not reach /discover.`
    ).toEqual([]);
  });
});

// ── Same row, same lens ─────────────────────────────────────────────────────

/**
 * A fake schema door encoding the resolver as it stands on 2026-09-12:
 *   • slug, no lens:   visible rows ranked USER < WORKSPACE < SHARED < SYSTEM
 *     (profile-repository.ts getBySlug) — a workspace twin OUTRANKS system;
 *   • slug, lens W:    workspace-owned(W) < SHARED < SYSTEM (getBySlugForWorkspace);
 *   • id:              `shared` is REFUSED with no lens (isAccessible), and
 *                      that refusal surfaces as a NOT_FOUND throw.
 */
type Row = {
  id: string;
  slug: string;
  scope: "system" | "shared" | "workspace";
  workspaceId?: string;
};

const ROWS: Row[] = [
  { id: "knowledge-system", slug: "knowledge", scope: "system" },
  {
    id: "knowledge-twin",
    slug: "knowledge",
    scope: "workspace",
    workspaceId: "ws-builder",
  },
  { id: "partner-shared", slug: "partner", scope: "shared" },
  {
    id: "partner-twin",
    slug: "partner",
    scope: "workspace",
    workspaceId: "ws-crm",
  },
  { id: "task-system", slug: "task", scope: "system" },
];

/** Each row's OWN schema — what the validator enforces for that row id. */
const OWN_SCHEMA: Record<
  string,
  Array<Record<string, unknown>>
> = Object.fromEntries(ROWS.map((r) => [r.id, [{ slug: `prop-of-${r.id}` }]]));

const LENSES: Array<string | null> = [null, "ws-builder", "ws-crm"];

function visibleAt(row: Row, lens: string | null): boolean {
  if (row.scope !== "workspace") return true;
  return lens === null || row.workspaceId === lens;
}

function fakeDoor(lens: string | null, calls: string[]) {
  return async (identifier: string): Promise<RowSchemaFetchResult> => {
    calls.push(identifier);
    const byId = ROWS.find((r) => r.id === identifier);
    if (byId) {
      if (byId.scope === "shared" && lens === null) {
        throw Object.assign(new Error("Profile not found"), {
          code: "NOT_FOUND",
        });
      }
      return {
        profile: { id: byId.id },
        effectiveProperties: OWN_SCHEMA[byId.id],
      };
    }
    const rank = (r: Row) =>
      r.scope === "workspace" ? 1 : r.scope === "shared" ? 2 : 3;
    const winner = ROWS.filter(
      (r) => r.slug === identifier && visibleAt(r, lens)
    ).sort((a, b) => rank(a) - rank(b))[0];
    if (!winner)
      throw Object.assign(new Error("Profile not found"), {
        code: "NOT_FOUND",
      });
    return {
      profile: { id: winner.id },
      effectiveProperties: OWN_SCHEMA[winner.id],
    };
  };
}

describe("discover describes each row by its OWN identity, at every lens", () => {
  it("the fixture actually contains the case that broke (non-vacuity)", async () => {
    // A twin that outranks its system row at the workspace-less lens — without
    // this, every assertion below could pass on a pod with no duplicates.
    const winner = await fakeDoor(null, [])("knowledge");
    expect(winner.profile?.id).toBe("knowledge-twin");
  });

  it("a row is either described with ITS OWN schema, or explicitly withheld — never another row's", async () => {
    const lies: string[] = [];
    let described = 0;
    for (const lens of LENSES) {
      for (const row of ROWS.filter((r) => visibleAt(r, lens))) {
        const result = await resolveRowSchema(row, fakeDoor(lens, []));
        if (result.status === "unavailable") continue;
        described++;
        if (result.effectiveProperties !== OWN_SCHEMA[row.id]) {
          lies.push(
            `lens=${lens ?? "none"} ${row.id} described with another row's schema`
          );
        }
      }
    }
    expect(described).toBeGreaterThan(0);
    expect(lies, lies.join("\n")).toEqual([]);
  });

  it("the system `knowledge` row resolves to ITSELF at the workspace-less lens (reachability, not just 'not wrong')", async () => {
    // Without this, a fix that withheld every duplicate would pass the test above.
    const result = await resolveRowSchema(ROWS[0], fakeDoor(null, []));
    expect(result).toEqual({
      status: "resolved",
      effectiveProperties: OWN_SCHEMA["knowledge-system"],
      // Its schema is its own — AND a slug write at this lens lands on the twin.
      // Omitting this is the half-truth that let a lens-less capture validate
      // against `knowledgeform` while discover showed `knowledgeForm` required.
      slugResolvesToProfileId: "knowledge-twin",
    });
  });

  it("a row its slug already identifies names no other write target", async () => {
    const result = await resolveRowSchema(ROWS[4], fakeDoor(null, []));
    expect(result).toEqual({
      status: "resolved",
      effectiveProperties: OWN_SCHEMA["task-system"],
    });
    const twinAtItsLens = await resolveRowSchema(
      ROWS[1],
      fakeDoor("ws-builder", [])
    );
    expect(twinAtItsLens).not.toHaveProperty("slugResolvesToProfileId");
  });

  it("a row the id path refuses is WITHHELD with the twin named — not shown as the twin, not a bare []", async () => {
    const result = await resolveRowSchema(ROWS[2], fakeDoor(null, []));
    expect(result).toEqual({
      status: "unavailable",
      resolvedProfileId: "partner-twin",
    });
  });

  it("a row that already resolves to itself costs ONE lookup (the id path is only paid for a twin)", async () => {
    const calls: string[] = [];
    await resolveRowSchema(ROWS[4], fakeDoor(null, calls));
    expect(calls).toEqual(["task"]);
  });

  it("only NOT_FOUND is classified — any other failure propagates", async () => {
    const boom = async (identifier: string): Promise<RowSchemaFetchResult> => {
      if (identifier === "knowledge")
        return { profile: { id: "knowledge-twin" } };
      throw Object.assign(new Error("db down"), {
        code: "INTERNAL_SERVER_ERROR",
      });
    };
    await expect(resolveRowSchema(ROWS[0], boom)).rejects.toThrow("db down");
  });

  it("an answer with NO identity throws — a broken door is not a twin", async () => {
    // Found the hard way: a fixture returning `{ effectiveProperties }` with no
    // `profile` was classified as "another row won" and withheld with a hint
    // that was simply false. Unverifiable identity must be LOUD.
    const noIdentity = async (): Promise<RowSchemaFetchResult> => ({
      effectiveProperties: [{ slug: "prop" }],
    });
    await expect(resolveRowSchema(ROWS[4], noIdentity)).rejects.toThrow(
      /no profile identity/
    );
  });
});

// ── Is the BUILT normaliser the seam runs on the one in source? ─────────────

const PRESENTATION_SRC = resolve(
  here,
  "..",
  "..",
  "..",
  "database",
  "src",
  "utils",
  "property-presentation.ts"
);
type Presentation = {
  resolvePropertyOptions: (d: Record<string, unknown>) => string[] | undefined;
  resolvePropertyLabel: (d: Record<string, unknown>) => string;
};
let fromSource: Presentation;
beforeAll(async () => {
  // Computed path: a static import would pull a file outside this package's
  // rootDir into `tsc -p` (TS6059), and would ALSO make it a second module
  // instance by accident. Here it is one on purpose, and only compared.
  fromSource = (await import(
    pathToFileURL(PRESENTATION_SRC).href
  )) as Presentation;
});

/** Inputs that exercise every rung of both resolvers — seed alone never reaches the fallbacks. */
const RUNG_PROBES: Array<Record<string, unknown>> = [
  {
    slug: "enum-wins",
    constraints: { enum: ["x"], options: ["y"] },
    uiHints: { options: ["z"] },
  },
  { slug: "constraints-options", constraints: { options: ["a"] } },
  { slug: "uihints-options", uiHints: { options: ["b"] } },
  { slug: "display-wins", uiHints: { displayName: "D", label: "L" } },
  { slug: "label-only", uiHints: { label: "  L  " } },
  { slug: "bare" },
];

describe("the BUILT @synap/database the seam runs on is not stale", () => {
  it("src and dist resolve every input identically — if not, rebuild @synap/database", () => {
    const inputs = [...SEEDED_DEFS, ...RUNG_PROBES];
    expect(inputs.length).toBeGreaterThan(RUNG_PROBES.length);
    const stale = inputs
      .filter(
        (d) =>
          JSON.stringify(builtOptions(d)) !==
            JSON.stringify(fromSource.resolvePropertyOptions(d)) ||
          builtLabel(d) !== fromSource.resolvePropertyLabel(d)
      )
      .map((d) => String(d.slug));
    expect(
      stale,
      `\`@synap/database\` dist disagrees with src/utils/property-presentation.ts, ` +
        `so every other assertion in this file is testing OLD code. Run ` +
        `\`pnpm turbo run build --filter=@synap/database\` and re-run.\n` +
        stale.join("\n")
    ).toEqual([]);
  });
});

describe("the handler still routes through both projections", () => {
  // Granularity is the FILE, not the call site: this sees the calls NAMED and
  // the dead keys ABSENT. It cannot prove the calls are reachable.
  const src = readFileSync(DISCOVER_FILE, "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );

  it("the handler maps its defs through `toDiscoverProperty`", () => {
    expect(src).toMatch(/defs\.map\(\s*toDiscoverProperty\s*\)/);
  });

  it("the handler resolves each row through `resolveRowSchema`, never by slug alone", () => {
    expect(src).toMatch(/await\s+resolveRowSchema\(/);
    expect(src).not.toMatch(/identifier:\s*profile\.slug/);
  });

  it("no reader in this file resurrects the keys nothing writes", () => {
    expect(src).not.toMatch(/constraints\s*\??\.\s*options/);
    expect(src).not.toMatch(/uiHints\s*\??\.\s*options/);
    expect(src).not.toMatch(/uiHints\s*\??\.\s*displayName/);
  });
});
