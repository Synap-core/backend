/**
 * No new wholesale mock of `@synap/database`.
 *
 * `vi.mock("@synap/database", () => ({ getDb }))` replaces the whole package
 * with the names the test lists. The next module that imports one more name
 * from it makes every such test throw "No 'x' export is defined on the mock",
 * in files the change never touched (the repeated reds behind the open-PR
 * pile of 26 Nov 2026). The one way is `databaseMock()` from
 * `@synap/database/testing`, which spreads the real module and overrides only
 * what a test fakes.
 *
 * The 106 files that still mock wholesale are listed in
 * database-mock-wholesale.baseline.txt. The list may only SHRINK: a new file
 * fails here, and a listed file that no longer mocks wholesale fails until its
 * line is removed. Not covered: a factory that spreads the real module by
 * another route than importOriginal / importActual.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SELF = "scripts/ci/database-mock-wholesale.tripwire.test.ts";
const BASELINE = "scripts/ci/database-mock-wholesale.baseline.txt";
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".turbo",
  "coverage",
  "worktrees",
]);

// vi.mock / vi.doMock of the package with a factory that takes no argument.
const WHOLESALE =
  /vi\.(?:do)?[mM]ock\(\s*["']@synap\/database["']\s*,\s*(?:async\s*)?(?:function\s*)?\(\s*\)\s*(?:=>|\{)/g;

/** True when the source mocks the package wholesale, with no spread of the real module. */
export function mocksWholesale(source: string): boolean {
  for (const m of source.matchAll(WHOLESALE)) {
    const factory = source.slice(
      m.index + m[0].length,
      m.index + m[0].length + 800
    );
    if (!factory.includes("importActual")) return true;
  }
  return false;
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("database-mock-wholesale: the detector", () => {
  const pkg = '"@synap/database"';
  it("flags an arrow factory and a multi-line one", () => {
    expect(mocksWholesale(`vi.mock(${pkg}, () => ({ getDb }));`)).toBe(true);
    expect(
      mocksWholesale(`vi.mock(\n  ${pkg},\n  async () => ({ getDb }),\n);`)
    ).toBe(true);
    expect(
      mocksWholesale(`vi.doMock(${pkg}, function () { return {}; });`)
    ).toBe(true);
  });
  it("passes a factory that spreads the real module", () => {
    expect(
      mocksWholesale(
        `vi.mock(${pkg}, async (importOriginal) => ({ ...(await importOriginal()) }));`
      )
    ).toBe(false);
    expect(
      mocksWholesale(
        `vi.mock(${pkg}, async () => ({ ...(await vi.importActual(${pkg})), getDb }));`
      )
    ).toBe(false);
  });
  it("ignores other packages and subpaths", () => {
    expect(
      mocksWholesale(`vi.mock("@synap/database/schema", () => ({}));`)
    ).toBe(false);
  });
});

describe("database-mock-wholesale: the ratchet", () => {
  const hits = testFiles(REPO)
    .map((f) => relative(REPO, f))
    .filter(
      (f) => f !== SELF && mocksWholesale(readFileSync(join(REPO, f), "utf8"))
    )
    .sort();
  const baseline = readFileSync(join(REPO, BASELINE), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .sort();

  it("no test file mocks @synap/database wholesale unless it is listed", () => {
    const added = hits.filter((f) => !baseline.includes(f));
    expect(
      added,
      `New wholesale mock of @synap/database. Use databaseMock() from "@synap/database/testing": vi.mock("@synap/database", (importOriginal) => databaseMock(importOriginal, { getDb: ... })). Never add a line to the baseline.`
    ).toEqual([]);
  });

  it("every listed file still mocks wholesale (remove the line when you convert one)", () => {
    const stale = baseline.filter((f) => !hits.includes(f));
    expect(
      stale,
      `Remove these lines from ${BASELINE}: the files no longer mock wholesale`
    ).toEqual([]);
  });
});
