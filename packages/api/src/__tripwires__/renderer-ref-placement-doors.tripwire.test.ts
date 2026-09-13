/**
 * TRIPWIRE — every door that PERSISTS a caller-supplied `RendererRef` refuses a
 * `source-app` ref outside user × detail.
 *
 * The defect: `setProfileRenderer` refused it, but `profiles.update` wrote the
 * same ref as a POD default through its own input schema. A refusal on one door
 * is a suggestion, not a rule.
 *
 * DERIVED, not hand-listed:
 *   1. Router files are found by scanning `src/routers` for the identifier
 *      `RendererRefSchema` (the wide wire union). Each must be loaded below.
 *   2. Doors are found by WALKING every procedure's input schema (zod v4
 *      `_zod.def`) for a discriminated union with a `source-app` option. A new
 *      procedure embedding the union joins the set by existing, and fails here
 *      until it has a refusal sample.
 *   3. Each derived door's sample (a `source-app` ref at a placement the rule
 *      refuses) must FAIL the real input parser — behavioural, not a scan.
 *
 * NOT covered (measured): a door whose input builds its ref from other fields
 * (Hub `profiles.setRenderer` builds a `cell` ref from `cellKey` — no union in
 * its schema, so it cannot carry `source-app`); the write services' own asserts
 * (`assertRendererRefAllowedForScope`) are covered by the service tests.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { profilesRouter } from "../routers/profiles.js";
import { capabilitiesRouter } from "../routers/capabilities.js";

type Parser = { safeParse: (v: unknown) => { success: boolean } };
type Def = { type?: string; [k: string]: unknown };

const ROUTERS_DIR = join(__dirname, "../routers");
const LOADED: Record<string, unknown> = {
  "profiles.ts": profilesRouter,
  "capabilities.ts": capabilitiesRouter,
};

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function defOf(schema: unknown): Def | null {
  const z = (schema as { _zod?: { def?: Def } } | null)?._zod;
  return z?.def ?? null;
}

/** Does this schema tree contain a discriminated union offering `source-app`? */
function embedsSourceApp(schema: unknown, seen = new Set<unknown>()): boolean {
  if (!schema || seen.has(schema)) return false;
  seen.add(schema);
  const def = defOf(schema);
  if (!def) return false;
  switch (def.type) {
    case "object":
      return Object.values(
        (schema as { shape: Record<string, unknown> }).shape
      ).some((s) => embedsSourceApp(s, seen));
    case "optional":
    case "nullable":
    case "default":
    case "readonly":
    case "nonoptional":
      return embedsSourceApp(def.innerType, seen);
    case "array":
      return embedsSourceApp(def.element, seen);
    case "union":
      return (def.options as unknown[]).some((opt) => {
        const kind = (opt as { shape?: Record<string, unknown> }).shape?.kind;
        const values = defOf(kind)?.values as unknown[] | undefined;
        return values?.includes("source-app") || embedsSourceApp(opt, seen);
      });
    default:
      return false;
  }
}

function derivedDoors(): Record<string, Parser> {
  const doors: Record<string, Parser> = {};
  for (const [file, r] of Object.entries(LOADED)) {
    const procs = (r as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    for (const [name, proc] of Object.entries(procs)) {
      const input = (proc as { _def: { inputs?: Parser[] } })._def.inputs?.[0];
      if (input && embedsSourceApp(input)) doors[`${file}::${name}`] = input;
    }
  }
  return doors;
}

const UUID = "00000000-0000-4000-8000-000000000001";
const SRC = { kind: "source-app" };

/** One refused placement per door. A door with no row here fails the test. */
const REFUSED_SAMPLES: Record<string, unknown[]> = {
  "profiles.ts::update": [
    { id: UUID, defaultDetailRenderer: SRC },
    { id: UUID, defaultListRenderer: SRC },
    { id: UUID, defaultDashboardRenderer: SRC },
  ],
  "profiles.ts::setProfileRendererOverride": [
    {
      profileSlug: "event",
      contentKind: "entity-detail",
      scope: "workspace",
      ref: SRC,
    },
    {
      profileSlug: "event",
      contentKind: "entity-detail",
      scope: "pod",
      ref: SRC,
    },
    {
      profileSlug: "event",
      contentKind: "collection",
      scope: "user",
      ref: SRC,
    },
  ],
  "capabilities.ts::setRenderer": [
    {
      capabilityId: UUID,
      pages: [{ slot: "overview", title: "Overview", ref: SRC }],
    },
    {
      capabilityId: UUID,
      scope: "capability",
      pages: [{ slot: "overview", title: "Overview", ref: SRC }],
    },
  ],
};

/** The one placement that stays allowed — proves the parsers are not refusing everything. */
const ALLOWED_SAMPLES: Record<string, unknown> = {
  "profiles.ts::setProfileRendererOverride": {
    profileSlug: "event",
    contentKind: "entity-detail",
    scope: "user",
    ref: SRC,
  },
  "profiles.ts::update": {
    id: UUID,
    defaultDetailRenderer: { kind: "cell", cellKey: "x", props: {} },
  },
  "capabilities.ts::setRenderer": {
    capabilityId: UUID,
    pages: [
      {
        slot: "overview",
        title: "Overview",
        ref: { kind: "cell", cellKey: "x", props: {} },
      },
    ],
  },
};

describe("renderer-ref placement: every persisting door refuses misplaced source-app", () => {
  it("every router file naming RendererRefSchema is loaded by this test", () => {
    // Comments stripped first: prose that names the schema (e.g. the narrowing
    // note in `entities/helpers.ts`) is not a consumer.
    const code = (f: string) =>
      readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const naming = walkFiles(ROUTERS_DIR)
      .filter((f) => /\bRendererRefSchema\b/.test(code(f)))
      .map((f) => relative(ROUTERS_DIR, f))
      .sort();
    // Non-vacuity: the scan still sees the two known consumers.
    expect(naming).toEqual(
      expect.arrayContaining(["capabilities.ts", "profiles.ts"])
    );
    expect(naming).toEqual(Object.keys(LOADED).sort());
  });

  it("the walker can still see a source-app union (self-check)", () => {
    const doors = Object.keys(derivedDoors());
    expect(doors.length).toBeGreaterThanOrEqual(3);
  });

  it("the derived door set is exactly the set with refusal samples", () => {
    expect(Object.keys(derivedDoors()).sort()).toEqual(
      Object.keys(REFUSED_SAMPLES).sort()
    );
  });

  it("each door's real input parser refuses the misplaced ref", () => {
    for (const [door, parser] of Object.entries(derivedDoors())) {
      for (const sample of REFUSED_SAMPLES[door] ?? []) {
        expect(
          parser.safeParse(sample).success,
          `${door} accepted ${JSON.stringify(sample)}`
        ).toBe(false);
      }
    }
  });

  it("each door still accepts its allowed placement (the refusal is targeted)", () => {
    for (const [door, parser] of Object.entries(derivedDoors())) {
      expect(
        parser.safeParse(ALLOWED_SAMPLES[door]).success,
        `${door} refused its allowed sample`
      ).toBe(true);
    }
  });
});
