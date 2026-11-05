/**
 * TRIPWIRE — one copy of the property-render RULES in backend source: the
 * classifier, the field plan, and the status tone (Wave 1 fork 1.1).
 *
 * This package used to hold an older five-tier classifier and its own
 * status→tone word table (`ENUM_TONE_MAP`) beside the app's newer ones, and
 * the copies drifted within weeks: a status-named string with no options was
 * a status here and text in the app, `rejected` was red here and calm in the
 * units table. The rules now live once, in this folder, and the tone comes
 * from `resolveStatusTone` (`../units`). This scan fails when either kind of
 * copy reappears in `@synap-core/types` or pod-admin (the two backend trees
 * that draw properties):
 *
 *   1. a DEFINITION of one of the rule functions outside this folder, or in
 *      two files of it. The hunted names are read from the rule modules'
 *      own `export function` lines, never hand-listed;
 *   2. a status→tone TABLE: a file with at least {@link TABLE_MIN_ROWS}
 *      lines mapping a status word (a key of the units `STATUS_TONE` table)
 *      to a tone name: an enum tone bucket, a unit tone, or a HeroUI chip
 *      colour (`danger`, `default`, …). Only `units/state.ts`, the table's
 *      home, may hold one. Pod-admin's proposal page kept such a table of
 *      HeroUI colours (6 rows) that painted `rejected` red and
 *      `approval_failed` amber, beside the units table reading them calm
 *      and red (Wave 1 step 4).
 *
 * WHAT IT CANNOT SEE (measured, not implied): a copy under another function
 * name, a table with fewer rows than the threshold (the largest legitimate
 * ones have 3: `focus-sessions/scorecard.ts` maps verdicts to its own tone
 * set; the removed `ENUM_TONE_MAP` had 16), a table keyed by a word the units
 * table does not hold, and any copy in another repo — app-bases, browser and
 * relay each need their own guard, since backend CI does not check them out.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_TONE, UNIT_TONES } from "../units/state.js";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "../../../..");
const HOME = "packages/types/src/property-render/";

/** The modules that hold the rules. Their exported functions are the hunted names. */
const RULE_MODULES = [
  "classify-property.ts",
  "property-classifier.ts",
  "entity-field-plan.ts",
  "enum-tone.ts",
];

/** The trees that draw properties in backend. */
const SCANNED = ["packages/types/src", "apps/pod-admin"];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);
const CODE = /\.(?:[cm]?ts|tsx)$/;
const TEST = /\.(?:test|spec)\.[cm]?tsx?$/;

const TABLE_MIN_ROWS = 4;
/** The one home of a status→tone table. */
const TABLE_HOME = "packages/types/src/units/state.ts";
/** Tone names a status word may be mapped to: buckets, unit tones, HeroUI chip colours. */
const TONE_NAMES = [
  ...new Set([
    "positive",
    "negative",
    "neutral",
    ...UNIT_TONES,
    "danger",
    "default",
    "secondary",
  ]),
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(name) && !TEST.test(name)) out.push(path);
  }
}

function ruleNames(): string[] {
  const names = new Set<string>();
  for (const file of RULE_MODULES) {
    const path = join(HERE, file);
    if (!existsSync(path)) continue;
    const src = readFileSync(path, "utf8");
    for (const m of src.matchAll(/^export function (\w+)/gm)) names.add(m[1]!);
  }
  return [...names].sort();
}

/** The names this source DEFINES (a function, or a const / let bound to one). */
export function definedRules(src: string, names: string[]): string[] {
  return names.filter((name) =>
    new RegExp(
      `(?:\\bfunction\\s+${name}\\s*[<(])|(?:\\b(?:const|let|var)\\s+${name}\\s*[:=])`
    ).test(src)
  );
}

/**
 * Lowercase status words; a key that is also a tone name (`success`, `error`)
 * is no evidence: a tone→tone map (`enum-tone.ts`) is rendering, not a table.
 */
const TONE_KEYS = new Set(TONE_NAMES.map((t) => t.toLowerCase()));
const STATUS_WORDS = new Set(
  Object.keys(STATUS_TONE).filter((w) => !TONE_KEYS.has(w))
);

/** How many lines map a status word to a tone name. */
export function toneTableRows(src: string): number {
  const row = new RegExp(
    `^\\s*["']?([A-Za-z_ -]+)["']?\\s*:\\s*["'](?:${TONE_NAMES.join("|")})["']`,
    "gm"
  );
  let rows = 0;
  for (const m of src.matchAll(row)) {
    if (STATUS_WORDS.has(m[1]!.toLowerCase())) rows += 1;
  }
  return rows;
}

describe("one copy of the property-render rules", () => {
  const names = ruleNames();
  const files: string[] = [];
  for (const top of SCANNED) walk(join(ROOT, top), files);
  const rel = (f: string) => relative(ROOT, f).split("\\").join("/");

  it("reads what it hunts (self-check)", () => {
    // The names come from the rule modules, not a hand list.
    expect(names).toEqual(
      expect.arrayContaining([
        "classifyPropertyKind",
        "planEntityFields",
        "getEnumTone",
      ])
    );
    expect(
      definedRules("function classifyPropertyKind(args) {}", names)
    ).toEqual(["classifyPropertyKind"]);
    expect(
      definedRules("export const getEnumTone = (v: string) => 1;", names)
    ).toEqual(["getEnumTone"]);
    // A call or an import is not a definition.
    expect(
      definedRules(
        'import { getEnumTone } from "x";\nconst t = getEnumTone(s);',
        names
      )
    ).toEqual([]);
    expect(
      toneTableRows(
        'const T = {\n  won: "positive",\n  lost: "negative",\n  "in progress": "positive",\n  rejected: "negative",\n};'
      )
    ).toBe(4);
    // A HeroUI chip-colour table and a unit-tone table count too; a
    // tone→tone map does not.
    expect(
      toneTableRows(
        'const C = {\n  pending: "warning",\n  approval_failed: "warning",\n  approved: "success",\n  rejected: "danger",\n  reverted: "default",\n};'
      )
    ).toBe(5);
    expect(
      toneTableRows(
        'const T = {\n  failed: "error",\n  draft: "textMuted",\n};'
      )
    ).toBe(2);
    expect(
      toneTableRows(
        'const M = {\n  success: "positive",\n  error: "negative",\n};'
      )
    ).toBe(0);
    // The home table is seen (so its exemption is not vacuous).
    expect(
      toneTableRows(readFileSync(join(ROOT, TABLE_HOME), "utf8"))
    ).toBeGreaterThanOrEqual(TABLE_MIN_ROWS);
    // Non-vacuity: the walk reached both trees.
    expect(files.some((f) => rel(f).startsWith("apps/pod-admin/"))).toBe(true);
    expect(files.length).toBeGreaterThan(500);
  });

  it("no rule function is defined outside its one home", () => {
    const where: Record<string, string[]> = {};
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const name of definedRules(src, names)) {
        (where[name] ??= []).push(rel(file));
      }
    }
    const copies = Object.entries(where).filter(
      ([, at]) => at.length !== 1 || !at[0]!.startsWith(HOME)
    );
    expect(
      copies,
      "A second copy of a property-render rule: import it from " +
        '"@synap-core/types/property-render" instead'
    ).toEqual([]);
    // Every hunted name was found at home: the scan sees the real ones.
    expect(Object.keys(where).sort()).toEqual(names);
  });

  it("no status→tone table: the tone comes from resolveStatusTone", () => {
    const tables = files
      .filter((f) => rel(f) !== TABLE_HOME)
      .map((f) => [rel(f), toneTableRows(readFileSync(f, "utf8"))] as const)
      .filter(([, rows]) => rows >= TABLE_MIN_ROWS);
    expect(
      tables,
      "A status word → tone table: read getEnumTone (property-render) or " +
        "resolveStatusTone (units) instead"
    ).toEqual([]);
  });
});
