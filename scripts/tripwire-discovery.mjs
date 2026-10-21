/**
 * tripwire-discovery.mjs — THE way a script finds every tripwire file.
 *
 * A tripwire is any `.test.ts`/`.test.tsx` under a `__tripwires__` directory
 * at any depth, or with "tripwire" in its file name. Found by PATTERN, never a
 * hand-listed path set (see tripwires.mjs's header for why). Shared by
 * `scripts/tripwires.mjs` (runs them) and `scripts/test-ratchet.mjs` (proves
 * each one was run by CI), so the two can never disagree on what a tripwire is.
 *
 * Self-contained on purpose (node: imports only).
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

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

export const isTripwire = (path) =>
  /\.tsx?$/.test(path) &&
  /\.test\.tsx?$/.test(path) &&
  (path.includes("/__tripwires__/") || /tripwire/i.test(path.split("/").pop()));

function walk(dir, found) {
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

/** Every tripwire file under `root`, absolute, sorted. */
export function discoverTripwires(root) {
  return walk(root, []).sort();
}

/**
 * The tripwires grouped by the workspace package that owns them (`packages/x`,
 * `apps/x`, or `.` for the repo root), each path relative to that package, so
 * each group runs under its own vitest config.
 */
export function tripwiresByPackage(root) {
  const byPackage = new Map();
  for (const f of discoverTripwires(root)) {
    const rel = relative(root, f);
    const m = rel.match(/^((?:packages|apps)\/[^/]+)\//);
    const pkgDir = m ? m[1] : ".";
    if (!byPackage.has(pkgDir)) byPackage.set(pkgDir, []);
    byPackage.get(pkgDir).push(relative(join(root, pkgDir), f));
  }
  return byPackage;
}
