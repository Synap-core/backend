/**
 * TRIPWIRE — `enumValues` is an AUTHORING spelling; `constraints.enum` is the
 * STORED TRUTH; exactly ONE function maps between them.
 *
 * ── What broke, and why a test rather than a comment ────────────────────────
 * `reconcile-workspace-from-definition.ts` folded a template's `enumValues`
 * into `uiHints`, which is the key NOTHING reads. 364 authored enum properties
 * across 30 workspace templates were therefore installed with their options
 * invisible to every picker AND unenforced by
 * `property-validation-service.ts`, whose guard is
 * `if (constraints.enum && …)` — for those rows the check did not fail, it
 * never ran, and any string was accepted.
 *
 * The defect was invisible for months because `ensure-system-profiles.ts`
 * writes `constraints.enum` correctly: built-in profiles worked, template
 * profiles did not, and the two populations never appeared in one screenshot.
 * A comment could not have caught that. A scan can.
 *
 * ── Scan hygiene (paid for three times over) ────────────────────────────────
 * Comments are STRIPPED before scanning. The prose above legitimately contains
 * `uiHints` and `enumValues`, and a previous tripwire in this codebase was
 * blinded by exactly this — a JSDoc brace truncated its `[^}]*` body match and
 * hid the very field it existed to catch. Object bodies are extracted
 * BRACE-BALANCED for the same reason: a regex that cannot see structure cannot
 * guard a structure.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoredConstraints, readStoredEnum } from "@synap/database";

const here = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = resolve(here, "..");
const DB_SRC = resolve(here, "..", "..", "..", "database", "src");

/** The ONE file allowed to name both spellings in a mapping. */
const MAPPER = "property-enum.ts";

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Remove block and line comments so prose can never blind the scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Extract the brace-balanced body of every `uiHints: {` / `uiHints = {`
 * literal. Returns the inner text of each.
 */
function uiHintsObjectBodies(src: string): string[] {
  const bodies: string[] = [];
  const opener = /uiHints\s*[:=]\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth === 0) bodies.push(src.slice(start, i - 1));
  }
  return bodies;
}

describe("property enum: one mapper, one stored key", () => {
  it("the scan actually reaches source (a vacuous green is the same false certificate)", () => {
    const files = [...walk(DB_SRC), ...walk(API_SRC)];
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(MAPPER))).toBe(true);
  });

  it("no `uiHints` literal carries `enumValues` — that key is unreadable by design", () => {
    const offenders: string[] = [];
    for (const file of [...walk(DB_SRC), ...walk(API_SRC)]) {
      if (file.endsWith(MAPPER)) continue;
      if (/\.test\.ts$/.test(file)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      for (const body of uiHintsObjectBodies(src)) {
        if (/\benumValues\b/.test(body)) {
          offenders.push(file.replace(resolve(here, "..", "..", ".."), ""));
        }
      }
    }
    expect(
      offenders,
      `These write a closed value set to \`uiHints.enumValues\`, which no reader ` +
        `keys on and \`property-validation-service\` cannot enforce. Fold it into ` +
        `\`constraints.enum\` via buildStoredConstraints() in utils/${MAPPER}.\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("nothing writes the third spelling `constraints.enumValues`", () => {
    // `PropertyCreationPanel` (synap-app) wrote `constraints.enumValues` — the
    // right object, the wrong key — so a HAND-CREATED closed choice was just as
    // unreadable and just as unvalidated as a template-installed one. Found
    // while reviewing the backfill migration, which originally matched only the
    // `uiHints` spelling and would have left every hand-made enum broken.
    const offenders: string[] = [];
    for (const file of [...walk(DB_SRC), ...walk(API_SRC)]) {
      if (file.endsWith(MAPPER)) continue;
      if (/\.test\.ts$/.test(file)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (/constraints\s*(\??\.|\[\s*["'`])\s*enumValues/.test(src)) {
        offenders.push(file.replace(resolve(here, "..", "..", ".."), ""));
      }
    }
    expect(
      offenders,
      `\`constraints.enumValues\` is a third spelling no reader keys on. The ` +
        `stored truth is \`constraints.enum\`.\n` +
        offenders.join("\n")
    ).toEqual([]);
  });
});

describe("the detector itself works (positive control)", () => {
  // ⚠️ `files.length > 200` proves the WALKER runs; it says nothing about the
  // MATCHER. Break the opener regex or the `BAD` pattern and every scan above
  // stays green forever with the invariant unguarded — which is the exact
  // "a guard that cannot catch its own defect" class this file was written for.
  // These feed known-bad source to the real functions.
  it("uiHintsObjectBodies finds the key in a literal, and survives a nested brace", () => {
    expect(
      uiHintsObjectBodies("propDefRepo.create({ uiHints: { enumValues: x } })")
    ).toHaveLength(1);
    expect(
      uiHintsObjectBodies(
        "create({ uiHints: { a: { b: 1 }, enumValues: x } })"
      )[0]
    ).toContain("enumValues");
  });

  it("stripComments removes prose but keeps code", () => {
    expect(
      stripComments("/* uiHints: { enumValues } */ const a = 1;")
    ).not.toContain("enumValues");
    expect(stripComments("const a = 1; // note\nconst b = 2;")).toContain(
      "const b"
    );
  });
});

describe("buildStoredConstraints — authoring spelling → stored truth", () => {
  it("folds the `enumValues` shorthand into `constraints.enum`", () => {
    expect(buildStoredConstraints({ enumValues: ["a", "b"] })).toEqual({
      enum: ["a", "b"],
    });
  });

  it("preserves constraints the template authored directly", () => {
    expect(
      buildStoredConstraints({
        enumValues: ["a"],
        constraints: { minLength: 2 },
      })
    ).toEqual({ minLength: 2, enum: ["a"] });
  });

  it("an explicitly authored `enum` WINS over the shorthand", () => {
    expect(
      buildStoredConstraints({
        enumValues: ["shorthand"],
        constraints: { enum: ["explicit"] },
      })
    ).toEqual({ enum: ["explicit"] });
  });

  it("merges the extra constraints the caller supplies", () => {
    expect(
      buildStoredConstraints({ enumValues: ["a"] }, { targetProfileSlug: "p" })
    ).toEqual({ targetProfileSlug: "p", enum: ["a"] });
  });

  it("adds no `enum` key when there is nothing to fold", () => {
    expect(buildStoredConstraints({})).toEqual({});
    expect(buildStoredConstraints({ enumValues: [] })).toEqual({});
    expect(buildStoredConstraints({ enumValues: "not-an-array" })).toEqual({});
    expect(buildStoredConstraints({ enumValues: [1, 2] })).toEqual({});
  });
});

describe("readStoredEnum — canonical first, legacy tolerated", () => {
  it("reads the canonical key", () => {
    expect(readStoredEnum({ constraints: { enum: ["a"] } })).toEqual(["a"]);
  });

  it("falls back to the legacy key for rows written before migration 0247", () => {
    expect(readStoredEnum({ uiHints: { enumValues: ["legacy"] } })).toEqual([
      "legacy",
    ]);
  });

  it("prefers canonical when a row carries BOTH (post-backfill steady state)", () => {
    expect(
      readStoredEnum({
        constraints: { enum: ["canonical"] },
        uiHints: { enumValues: ["legacy"] },
      })
    ).toEqual(["canonical"]);
  });

  it("returns undefined when neither key holds a usable list", () => {
    expect(readStoredEnum({})).toBeUndefined();
    expect(readStoredEnum({ constraints: { enum: [] } })).toBeUndefined();
    expect(readStoredEnum({ constraints: { enum: "nope" } })).toBeUndefined();
  });
});
