import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — every `ensureSystemProfiles()` call site logs its result through
 * `reportEnsureSystemProfilesResult`.
 *
 * WHY: the seeder catches its own failure into `{ status: "error" }` and does
 * not throw, so a caller's `catch` never fires. All three boot call sites
 * logged that result at INFO as "reconciled" / "seeded" / "check complete" — a
 * failed schema reconcile read as a successful one in every boot log.
 *
 * THE SET IS DERIVED: every non-test `.ts` under `packages/*\/src` and
 * `apps/*\/src` is scanned for `await ensureSystemProfiles()`; a new call site
 * joins the scan by existing. Comments are stripped first so a docblock that
 * mentions the call cannot satisfy (or trip) the scan.
 *
 * WHAT IT DOES NOT SEE: granularity is the call site's own statement window —
 * from the call to the next `catch` (or 600 characters). It proves the result
 * is handed to the reporter there and not spread into a `.info(` there; it does
 * not prove the reporter is on every control-flow path. The window is not the
 * whole file on purpose: `startup-hooks.ts` reuses `result` for the next
 * seeder's (legitimate) info log, which a file-wide check misread as an offender.
 */

const BACKEND_ROOT = join(process.cwd(), "..", "..");
const ROOTS = ["packages", "apps"].map((d) => join(BACKEND_ROOT, d));

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const pkg of readdirSync(root)) {
      const src = join(root, pkg, "src");
      try {
        if (statSync(src).isDirectory()) walk(src, out);
      } catch {
        // a package without src/ has no call sites to scan
      }
    }
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const CALL = /(?:const|let)\s+(\w+)\s*=\s*await\s+ensureSystemProfiles\(\s*\)/g;
const ANY_CALL = /await\s+ensureSystemProfiles\(\s*\)/g;

describe("ensureSystemProfiles boot honesty", () => {
  const files = sourceFiles();
  const sites: Array<{ file: string; variable: string; after: string }> = [];
  let bareCalls = 0;
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    const captured = [...code.matchAll(CALL)];
    bareCalls += [...code.matchAll(ANY_CALL)].length - captured.length;
    for (const m of captured) {
      sites.push({
        file: relative(BACKEND_ROOT, file),
        variable: m[1]!,
        after: (() => {
          const window = code.slice(m.index!, m.index! + 600);
          const c = window.search(/\bcatch\b/);
          return c === -1 ? window : window.slice(0, c);
        })(),
      });
    }
  }

  it("finds the known call sites (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(sites.map((s) => s.file)).toContain(
      "packages/jobs/src/workers/index.ts"
    );
  });

  it("never discards the result", () => {
    expect(bareCalls).toBe(0);
  });

  it("hands every result to reportEnsureSystemProfilesResult and never spreads it into logger.info", () => {
    const offenders = sites.filter((s) => {
      const reported = new RegExp(
        `reportEnsureSystemProfilesResult\\(\\s*\\w+\\s*,\\s*${s.variable}\\b`
      ).test(s.after);
      const infoSpread = new RegExp(
        `\\.info\\(\\s*\\{\\s*\\.\\.\\.${s.variable}\\b`
      ).test(s.after);
      return !reported || infoSpread;
    });
    expect(offenders.map((s) => `${s.file} (${s.variable})`)).toEqual([]);
  });
});
