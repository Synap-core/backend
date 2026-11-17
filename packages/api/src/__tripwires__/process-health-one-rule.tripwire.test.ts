/**
 * TRIPWIRE: ONE process health rule, ONE home for its words (Process wave plan
 * 0adf8352, W2; review of #1063).
 *
 *  1. The process read derives health through the leaf's rule: the source of
 *     `services/playbooks/process-read.ts` calls `deriveProcessHealth(`.
 *  2. No other backend source declares the rule's precedence states: the
 *     health state tokens that exist only for it (`config-error`,
 *     `unresolved-failure`, `blocked-by-policy`, `never-run`) appear as string
 *     literals only in `packages/types/src/processes/health.ts`.
 *  3. The English health words live only in the vocabulary door
 *     (`packages/types/src/vocabulary/`, its catalog rows; a status label such
 *     as "Blocked by policy" is the door's too): no surface or service
 *     hand-writes "Latest run failed" and the like.
 *
 * The scan is DERIVED: every non-test `.ts` / `.tsx` under `packages/<pkg>/src`
 * and `apps/<app>/src` (a new file joins by existing). Self-checks prove each
 * literal is still visible where it is allowed.
 *
 * NOT COVERED: a precedence written WITHOUT these tokens (a new state with a
 * new name; the leaf's reachability tripwire covers the state list), a token
 * built by concatenation, and the other repos (the browser and pod admin have
 * their own guards).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "../../../..");
const HEALTH = "packages/types/src/processes/health.ts";
const CATALOG = "packages/types/src/vocabulary/catalog.en.ts";
const VOCABULARY = "packages/types/src/vocabulary/";
const READ = "packages/api/src/services/playbooks/process-read.ts";

const STATE_TOKENS = [
  "config-error",
  "unresolved-failure",
  "blocked-by-policy",
  "never-run",
];
const ENGLISH_WORDS = [
  "Latest run failed",
  "Latest status unresolved",
  "Running · previous run failed",
  "Blocked by policy",
  "Configuration error",
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (
      /\.tsx?$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts")
    )
      out.push(path);
  }
}

function sources(): string[] {
  const out: string[] = [];
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, top))) {
      const src = join(ROOT, top, pkg, "src");
      try {
        if (statSync(src).isDirectory()) walk(src, out);
      } catch {
        // a package with no src/ (config-only) is not scanned
      }
    }
  }
  return out;
}

const literal = (token: string) =>
  new RegExp(`["'\`]${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);

describe("process health: one rule, one home for its words", () => {
  const files = sources();
  const rel = (f: string) => relative(ROOT, f);

  it("scans the backend sources (non-vacuous)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(rel)).toContain(HEALTH);
    expect(files.map(rel)).toContain(READ);
  });

  it("the process read derives health through the leaf's rule", () => {
    const src = readFileSync(join(ROOT, READ), "utf8");
    expect(src).toMatch(/\bderiveProcessHealth\(/);
  });

  it("only the leaf declares the precedence states", () => {
    const health = readFileSync(join(ROOT, HEALTH), "utf8");
    for (const token of STATE_TOKENS) {
      expect(health, `self-check: ${token}`).toMatch(literal(token));
    }
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) === HEALTH) continue;
      const src = readFileSync(f, "utf8");
      for (const token of STATE_TOKENS) {
        if (literal(token).test(src)) offenders.push(`${rel(f)}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only the vocabulary door holds the English health words", () => {
    const catalog = readFileSync(join(ROOT, CATALOG), "utf8");
    for (const words of ENGLISH_WORDS) {
      expect(catalog, `self-check: ${words}`).toContain(words);
    }
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f).startsWith(VOCABULARY)) continue;
      const src = readFileSync(f, "utf8");
      for (const words of ENGLISH_WORDS) {
        if (src.includes(words)) offenders.push(`${rel(f)}: ${words}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
