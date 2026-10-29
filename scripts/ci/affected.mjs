/**
 * affected.mjs — which tests a pull request must run, DERIVED from the
 * repository (founder, 2026-10-29, "One trunk, three CI tiers").
 *
 * ── THE THREE TIERS ──────────────────────────────────────────────────────────
 *   PR (required)   Preflight, the Release gate, and the tests of what the
 *                   change can break (this file). API e2e only when the API
 *                   surface changed.
 *   main            every push runs everything: Full suite, API e2e, Docker,
 *                   deploy tests. Nobody waits on it; a red main names the
 *                   commits since its last all-green run.
 *   release / pods  a pod updates only to a main commit whose post-merge run
 *                   was ALL green (scripts/ci/release-gate-wait.mjs).
 *
 * ── THE GRAPH (never hand-listed) ────────────────────────────────────────────
 * Two derived sources, at two granularities:
 *   1. PACKAGES: P depends on Q when P's package.json names Q with
 *      `workspace:` (dependencies, devDependencies, peerDependencies,
 *      optionalDependencies). A change in Q runs Q, P and P's dependents.
 *   2. TEST FILES: a test file T of package P that names a path inside
 *      package Q, either repo-relative (`"packages/database/migrations"`) or
 *      relative and resolving into Q (`"../../database/src/x"`, an import or
 *      a vi.mock), runs whenever Q is affected. Only T runs: P's code does
 *      not reach Q through T, so P's other tests and P's dependents are not
 *      affected by it. Measured 2026-10-29: taken at the PACKAGE level, these
 *      references form one cycle (packages/api tests read packages/database,
 *      packages/database tests read packages/api...) and every change would
 *      reach every package.
 * TRIPWIRES run on every PR, whatever changed: they are the tests that read
 * across the tree (369 files on 2026-10-29; packages/api's 321 cost ~550
 * worker-seconds in the shard plan, about 3 min on 3 workers).
 * What this cannot see: a path built from pieces at run time
 * (`join(__dirname, "..", "..", "database")`) in a test that is not a
 * tripwire. Main runs the whole suite after the merge and names the commits
 * since its last all-green run when it goes red.
 *
 * ── THE FULL SUITE ON A PR ───────────────────────────────────────────────────
 * A change to a path everything rests on runs everything:
 *   - any path outside a workspace package (root config, the lockfile,
 *     scripts/, .github/, skills/, deploy/, docs that tests read...), except
 *     SUITE_NEUTRAL: generated files no test reads;
 *   - a directory under apps/ or packages/ that is not a workspace package;
 *   - a non-test file of packages/database (schema, migrations),
 *     packages/types or packages/core.
 *
 * ── TEST FILES ───────────────────────────────────────────────────────────────
 * A changed `*.test.*` file runs its own package and is not followed to the
 * dependents: no package imports another package's test file. Test HELPERS
 * (`__tests__/helpers.ts`, `test-utils/`) are not test files and are followed.
 *
 * Self-contained (node: built-ins only): the "What changed" job runs it
 * before any install.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const TEST_FILE = /\.test\.(ts|tsx|mts|cts|mjs|cjs|js)$/;

/** Non-test files of these packages run the full suite: everything rests on them. */
export const FULL_SUITE_PACKAGES = [
  "packages/database",
  "packages/types",
  "packages/core",
];

/**
 * Paths outside every workspace package that no test file reads, so their
 * change widens no suite. docs/reference/ is generated from packages/api
 * (scripts/docs/gen-reference.ts) and checked by its own required job,
 * "Reference docs are current", which runs on every PR. Measured on finding
 * 606c00e3's six PRs: four of them touched docs/reference/, and without
 * this each one ran the full suite. ci-changes.tripwire.test.ts scans every
 * test file for a path this list names: a test that starts reading one must
 * take it off the list.
 */
export const SUITE_NEUTRAL = [/^docs\/reference\//];

/**
 * Paths whose change runs "API e2e" (the founder's rule: only when the HTTP
 * routes or the API surface change). The e2e suite boots apps/api and calls
 * it over HTTP: the server itself, the routers, the auth and access layer in
 * front of them, the wire contracts and the e2e suite itself. A full-suite
 * change runs it too. NOT run for: a change confined to a service under
 * packages/api/src/services that keeps every route's shape; main runs the e2e
 * suite after every merge.
 */
export const API_SURFACE = [
  /^apps\/api\//,
  /^packages\/test-e2e\//,
  /^packages\/api\/src\/(routers|middleware|access)\//,
  /^packages\/api\/src\/(root|trpc|init-trpc|context|public-doors|index)\.ts$/,
  /^packages\/(hub-protocol|api-types|auth)\//,
];

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

/** The package globs of pnpm-workspace.yaml (`apps/*` → "apps"). */
export function workspaceGlobs(root) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s+-\s+"?([^"\n]+?)\/\*"?\s*$/gm)].map(
    (m) => m[1]
  );
  if (globs.length === 0)
    throw new Error("no package globs found in pnpm-workspace.yaml");
  return globs;
}

/** Every workspace package: { dir, name, deps (workspace package names) }. */
export function workspacePackages(root) {
  const out = [];
  for (const g of workspaceGlobs(root)) {
    const base = join(root, g);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      const pj = join(base, d.name, "package.json");
      if (!d.isDirectory() || !existsSync(pj)) continue;
      const p = JSON.parse(readFileSync(pj, "utf8"));
      const all = {
        ...p.dependencies,
        ...p.devDependencies,
        ...p.peerDependencies,
        ...p.optionalDependencies,
      };
      out.push({
        dir: `${g}/${d.name}`,
        name: p.name,
        deps: Object.entries(all)
          .filter(([, v]) => String(v).startsWith("workspace:"))
          .map(([k]) => k),
      });
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

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
      if (!SKIP_DIRS.has(e.name)) walk(full, found);
    } else if (TEST_FILE.test(e.name)) {
      found.push(full);
    }
  }
  return found;
}

/** The workspace package dir that holds a repo-relative path, or null. */
export function packageOf(path, dirs) {
  return (
    dirs
      .filter((d) => path === d || path.startsWith(`${d}/`))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/** The workspace package dirs a test file's text names by path (not its own). */
export function namedPackages(text, file, pkg, dirs, root) {
  const named = new Set();
  for (const m of text.matchAll(
    /(?:^|[^A-Za-z0-9_.-])((?:apps|packages)\/[A-Za-z0-9_.-]+)\//g
  ))
    named.add(m[1]);
  for (const m of text.matchAll(/(['"`])(\.\.?\/[^'"`\s$]*)\1/g)) {
    const target = relative(
      root,
      resolve(dirname(join(root, file)), m[2])
    ).replaceAll("\\", "/");
    const q = packageOf(target, dirs);
    if (q) named.add(q);
  }
  return [...named].filter((q) => q !== pkg && dirs.includes(q)).sort();
}

/**
 * Test files that name a path inside ANOTHER workspace package, as
 * { file, pkg: the test's package, reads: [package dirs it names] }.
 * `keep(file)` picks the files to scan (the caller leaves tripwires out: they
 * run on every PR).
 */
export function testReferences(root, dirs, keep = () => true) {
  const out = [];
  for (const pkg of dirs)
    for (const abs of walk(join(root, pkg), [])) {
      const file = relative(root, abs).replaceAll("\\", "/");
      if (!keep(file)) continue;
      const reads = namedPackages(
        readFileSync(abs, "utf8"),
        file,
        pkg,
        dirs,
        root
      );
      if (reads.length) out.push({ file, pkg, reads });
    }
  return out;
}

/** dir → the set of package dirs whose package.json depends on it DIRECTLY. */
export function dependentsGraph(packages) {
  const byName = new Map(packages.map((p) => [p.name, p.dir]));
  const graph = new Map(packages.map((p) => [p.dir, new Set()]));
  for (const p of packages)
    for (const dep of p.deps) {
      const d = byName.get(dep);
      if (d && d !== p.dir) graph.get(d).add(p.dir);
    }
  return graph;
}

/**
 * The graph of a checkout: { graph: dependentsGraph, refs: testReferences of
 * every test file that is not a tripwire }.
 */
export function loadGraph(root, isTripwire) {
  const packages = workspacePackages(root);
  const dirs = packages.map((p) => p.dir);
  return {
    graph: dependentsGraph(packages),
    refs: testReferences(root, dirs, (f) => !isTripwire(f)),
  };
}

/** Every package reachable from `start` through dependents, `start` included. */
export function closure(start, graph) {
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length) {
    const d = queue.shift();
    for (const n of graph.get(d) ?? [])
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  }
  return seen;
}

/**
 * The PR tier for a list of changed paths (none of them docs-only: the caller
 * routes docs-only changes first). `graph` and `refs` come from loadGraph().
 * Returns { scope: "full" | "affected", dirs, tests, e2e, why }:
 *   dirs   the packages whose whole suite runs (touched + dependents, and the
 *          packages of changed test files)
 *   tests  test files of OTHER packages that read an affected package by path
 *   why    what forced the full suite, or what was selected and from what
 */
export function selectTier(files, { graph, refs = [] }) {
  const dirs = [...graph.keys()];
  const full = [];
  const touched = new Set();
  const testOnly = new Set();
  const neutral = [];
  for (const f of files) {
    if (SUITE_NEUTRAL.some((re) => re.test(f))) {
      neutral.push(f);
      continue;
    }
    const pkg = packageOf(f, dirs);
    if (!pkg) {
      full.push(
        /^(apps|packages)\/[^/]+\//.test(f)
          ? `${f} (${f.split("/").slice(0, 2).join("/")} is not a workspace package)`
          : `${f} (outside every workspace package)`
      );
      continue;
    }
    if (TEST_FILE.test(f)) {
      testOnly.add(pkg);
      continue;
    }
    if (FULL_SUITE_PACKAGES.includes(pkg)) {
      full.push(`${f} (${pkg}: every package rests on it)`);
      continue;
    }
    touched.add(pkg);
  }
  const e2e = files.some((f) => API_SURFACE.some((re) => re.test(f)));
  if (full.length)
    return {
      scope: "full",
      dirs: [],
      tests: [],
      e2e: true,
      why: [
        `full suite: ${full.slice(0, 8).join("; ")}${full.length > 8 ? `; and ${full.length - 8} more` : ""}`,
      ],
    };
  const reach = closure(touched, graph);
  const brought = [...reach].filter((d) => !touched.has(d)).sort();
  const extraPkgs = [...testOnly].filter((d) => !reach.has(d)).sort();
  const affected = new Set([...reach, ...testOnly]);
  const tests = refs
    .filter((r) => !affected.has(r.pkg) && r.reads.some((q) => affected.has(q)))
    .map((r) => r.file)
    .sort();
  return {
    scope: "affected",
    dirs: [...affected].sort(),
    tests,
    e2e,
    why: [
      touched.size
        ? `changed: ${[...touched].sort().join(", ")}`
        : "no package source changed",
      ...(brought.length ? [`their dependents: ${brought.join(", ")}`] : []),
      ...(extraPkgs.length ? [`test files only: ${extraPkgs.join(", ")}`] : []),
      ...(tests.length
        ? [
            `${tests.length} test file(s) of other packages that read them by path`,
          ]
        : []),
      ...(neutral.length
        ? [
            `read by no test: ${neutral.length} generated file(s) under docs/reference/`,
          ]
        : []),
      "every tripwire",
    ],
  };
}
