#!/usr/bin/env node
/**
 * RUN EVERY TRIPWIRE — found by PATTERN, never by a hand-listed path set.
 *
 * A tripwire is a test that guards an architectural invariant ("all writes go
 * through the one door", "this enum matches that enum"). They only work if they
 * actually run, and the obvious command —
 *
 *     vitest run src/__tripwires__
 *
 * — silently covers only PART of them. Measured 2026-08-03: 58 tripwire files
 * exist in this repo; 42 live under `__tripwires__/`, and 16 use the sibling
 * `*.tripwire.test.ts` naming and sit next to the code they guard. Any command
 * scoped to the directory misses those 16 entirely and still reports green.
 *
 * That is the documented failure mode `tripwires-lose-coverage-silently`: a
 * source-scanning guard that greps a FIXED list stays GREEN over a fresh hole.
 * So this script never hardcodes paths. It DISCOVERS every `.test.ts`/`.test.tsx`
 * that either sits under a `__tripwires__` directory at any depth, or carries
 * "tripwire" in its filename — then runs exactly that set and prints the
 * discovered count and the split between the two conventions, so a drop in
 * coverage is visible rather than silent.
 *
 * Usage:  node scripts/tripwires.mjs            (this is `pnpm tripwires`)
 *         node scripts/tripwires.mjs --list     print the discovered files only
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Never descend into these: build output and agent worktrees both contain stale
// COPIES of the suite. Running them forges the count and replays fixed failures.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".git",
  "coverage",
  "worktrees",
]);

const isTripwire = (path) =>
  /\.tsx?$/.test(path) &&
  /\.test\.tsx?$/.test(path) &&
  (path.includes("/__tripwires__/") || /tripwire/i.test(path.split("/").pop()));

function walk(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, found);
    } else if (isTripwire(full)) {
      found.push(full);
    }
  }
  return found;
}

const files = walk(REPO_ROOT).sort();

if (files.length === 0) {
  console.error(
    "✗ Discovered ZERO tripwire files. That is itself the bug this script " +
      "exists to prevent — either the naming convention changed or the walk is " +
      "broken. Do not treat this as green."
  );
  process.exit(1);
}

// Group by the package that owns them, so each runs under its own vitest config
// (mocks, env and setupFiles differ per package).
const byPackage = new Map();
for (const f of files) {
  const rel = relative(REPO_ROOT, f);
  const m = rel.match(/^((?:packages|apps)\/[^/]+)\//);
  const pkgDir = m ? m[1] : ".";
  if (!byPackage.has(pkgDir)) byPackage.set(pkgDir, []);
  byPackage.get(pkgDir).push(relative(join(REPO_ROOT, pkgDir), f));
}

console.log(
  `Discovered ${files.length} tripwire file(s) across ${byPackage.size} package(s):`
);
for (const [pkg, list] of byPackage) {
  const dirCount = list.filter((f) => f.includes("__tripwires__/")).length;
  console.log(
    `  ${pkg}: ${list.length} (${dirCount} under __tripwires__/, ${list.length - dirCount} sibling *tripwire*)`
  );
}

if (process.argv.includes("--list")) {
  console.log();
  for (const f of files) console.log(relative(REPO_ROOT, f));
  process.exit(0);
}

let failed = 0;
for (const [pkg, list] of byPackage) {
  console.log(`\n─── ${pkg} ───`);
  const r = spawnSync("npx", ["vitest", "run", ...list], {
    cwd: join(REPO_ROOT, pkg),
    stdio: "inherit",
  });
  if (r.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n✗ tripwires RED in ${failed} package(s).`);
  console.error(
    "A tripwire fires when an architectural invariant was broken. Fix the " +
      "SOURCE it points at — do not relax the tripwire."
  );
  process.exit(1);
}
console.log(`\n✓ all ${files.length} tripwire file(s) green.`);
