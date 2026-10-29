/**
 * affected.mjs — which tests a pull request must run, DERIVED from the
 * repository.
 *
 * ── THE THREE TIERS ──────────────────────────────────────────────────────────
 *   PR (required)   Preflight, the Release gate, and the tests of what the
 *                   change can break (this file). API e2e only when the API
 *                   surface changed.
 *   main            every push runs everything: Full suite, API e2e, Docker,
 *                   deploy tests. A red main names its culprit.
 *   release / pods  a pod updates only to a main commit whose post-merge run
 *                   was ALL green (scripts/ci/release-gate-wait.mjs).
 *
 * ── WHAT A PR RUNS (scope "selected") ────────────────────────────────────────
 *   1. every test file the change reaches through the import graph
 *      (scripts/ci/import-graph.mjs: imports, transitively, and the files and
 *      directories a file reads by path), a changed test file included;
 *   2. every test file that names a changed file's package by path;
 *   3. when the known-red baseline changed: every file it names, before and
 *      after the change (a removed line claims a file passes: it runs);
 *   4. EVERY tripwire, whatever changed: they read across the tree (381 files
 *      on 2026-10-29, ~5.3 min of one shard in the shard plan's costs).
 * Package source goes through the graph, packages/types, packages/database
 * (its src) and packages/core included.
 *
 * ── THE FULL SUITE (FULL, one reason each) ───────────────────────────────────
 *   package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc
 *                        what is installed, and which packages exist: every
 *                        test resolves its imports through them
 *   turbo.json           how every package is built before its tests run
 *   tsconfig*.json, .node-version
 *                        how every file is compiled and which Node runs it
 *   vitest*.config.* (at the root)
 *                        how the root tripwires run
 *   the test runner and the selector: scripts/test-ratchet*.mjs,
 *   tripwire-discovery.mjs, test-floors.json, scripts/ci-changes.mjs,
 *   scripts/ci/affected.mjs, scripts/ci/import-graph.mjs,
 *   scripts/strip-comments.mjs
 *                        they plan, run and judge every test, from the PR's
 *                        own checkout: a run they planned cannot vouch for a
 *                        change to them
 *   .github/workflows/ci.yml, .github/actions/**
 *                        the shard jobs themselves: their database service,
 *                        env, migrate step and install layout (a DB test that
 *                        skips without DATABASE_URL would read green)
 *   packages/database/migrations/**
 *                        every DATABASE_URL test runs on the migrated schema
 *   any other path outside a workspace package, and a directory under apps/
 *   or packages/ that is not a workspace package (fail-safe: unknown = full)
 *
 * ── NARROWED (through the graph's read edges, plus the jobs that own them) ──
 *   skills/**            the tests and modules that read skills by path
 *   deploy/**, kratos/**, docker/**, Dockerfile, .dockerignore, install.sh,
 *   synap                the deploy tests and the Docker image (their own
 *                        jobs, IMAGE_INPUTS in ci-changes.mjs) and the tests
 *                        that read them
 *   .github/** (not ci.yml, not the actions), ci/**, scripts/** (not the
 *   runner or the selector)
 *                        the tests that import or read them; every CI
 *                        tripwire runs anyway; a changed workflow runs itself
 *   docs/** (what ci-changes.mjs's DOCS_ONLY does not skip), CLAUDE.md,
 *   AGENTS.md, .claude/** the tests that read them by name
 * SUITE_NEUTRAL paths (generated, read by no test) widen nothing.
 *
 * Self-contained (node: built-ins only): the "What changed" job runs it
 * before any install.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildGraph, reach } from "./import-graph.mjs";

export const TEST_FILE = /\.test\.(ts|tsx|mts|cts|mjs|cjs|js)$/;

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

/** Paths that run the full suite (header, "THE FULL SUITE"). */
export const ROOT_FULL = [
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|turbo\.json|\.node-version)$/,
  /^tsconfig[^/]*\.json$/,
  /^vitest[^/]*\.config\.[mc]?[jt]s$/,
  /^scripts\/(test-ratchet[^/]*\.mjs|tripwire-discovery\.mjs|test-floors\.json)$/,
  /^scripts\/(ci-changes|strip-comments)\.mjs$/,
  /^scripts\/ci\/(affected|import-graph)\.mjs$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/actions\//,
  /^packages\/database\/migrations\//,
];

/** Paths outside every package that go through the graph (header, "NARROWED"). */
export const NARROWED = [
  /^skills\//,
  /^(deploy|kratos|docker)\//,
  /^(Dockerfile[^/]*|\.dockerignore|install\.sh|synap)$/,
  /^(\.github|ci|scripts)\//,
  /^docs\//,
  /^(CLAUDE|AGENTS)\.md$/,
  /^\.claude\//,
];

/** The known-red baseline: when it changes, every file it names runs. */
export const BASELINE = "scripts/test-ratchet-baseline.txt";

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

/**
 * The packages whose `test` script is `vitest run …`: the ratchet's package
 * suites (test-ratchet.mjs packageRuns reads the same scripts).
 */
export function suiteDirs(root) {
  return workspacePackages(root)
    .map((p) => p.dir)
    .filter((d) =>
      /^vitest run(\s|$)/.test(
        JSON.parse(readFileSync(join(root, d, "package.json"), "utf8")).scripts
          ?.test ?? ""
      )
    );
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

/** The files a baseline text names (one per entry line). */
export function baselineFiles(text) {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("|")[0].trim())
    .filter(Boolean);
}

/**
 * The graph of a checkout: { dirs (workspace package dirs), graph (the
 * package-level dependents graph, for selectPackageTier), imports
 * (import-graph.mjs buildGraph; null with `{ imports: false }`: the culprit
 * finder needs only the package graph, and the import graph costs ~5 s),
 * refs (testReferences of every test file that is not a tripwire), tripwires
 * (every tripwire, repo-relative, when `imports`), baseline (the files the
 * checkout's baseline names) }.
 */
export function loadGraph(
  root,
  isTripwire,
  { imports: withImports = true } = {}
) {
  const packages = workspacePackages(root);
  const dirs = packages.map((p) => p.dir);
  const imports = withImports ? buildGraph(root) : null;
  const baselinePath = join(root, BASELINE);
  return {
    dirs,
    graph: dependentsGraph(packages),
    imports,
    refs: testReferences(root, dirs, (f) => !isTripwire(f)),
    tripwires: imports ? imports.files.filter(isTripwire) : [],
    baseline: existsSync(baselinePath)
      ? baselineFiles(readFileSync(baselinePath, "utf8"))
      : [],
  };
}

const cap = (xs, n = 8) =>
  `${xs.slice(0, n).join("; ")}${xs.length > n ? `; and ${xs.length - n} more` : ""}`;

/**
 * The PR tier for a list of changed paths (none of them docs-only: the caller
 * routes docs-only changes first). `g` comes from loadGraph(); `baseBaseline`
 * is the list of files the BASE commit's baseline names, when it changed.
 * Returns { scope: "full" | "selected", tests, e2e, why }:
 *   tests  scope=selected: every test file to run (sorted), tripwires included
 *   why    what forced the full suite, or what was selected and from what
 */
export function selectTier(files, g, { baseBaseline = [] } = {}) {
  const full = [];
  const neutral = [];
  const graphed = [];
  for (const f of files) {
    if (SUITE_NEUTRAL.some((re) => re.test(f))) {
      neutral.push(f);
      continue;
    }
    if (ROOT_FULL.some((re) => re.test(f))) {
      full.push(
        `${f} (root config, the test runner, the selector, the shard jobs or a migration: every test rests on it)`
      );
      continue;
    }
    const pkg = packageOf(f, g.dirs);
    if (pkg) {
      graphed.push(f);
      continue;
    }
    if (/^(apps|packages)\/[^/]+\//.test(f)) {
      full.push(
        `${f} (${f.split("/").slice(0, 2).join("/")} is not a workspace package)`
      );
      continue;
    }
    if (f === BASELINE || NARROWED.some((re) => re.test(f))) {
      graphed.push(f);
      continue;
    }
    full.push(`${f} (outside every workspace package, not a narrowed path)`);
  }
  const e2e = files.some((f) => API_SURFACE.some((re) => re.test(f)));
  if (full.length)
    return {
      scope: "full",
      tests: [],
      e2e: true,
      why: [`full suite: ${cap(full)}`],
    };

  const r = reach(graphed, g.imports);
  const selected = new Set(r.tests);
  const fromGraph = selected.size;
  // A changed test file always runs itself (even one the graph cannot read).
  for (const f of graphed) if (TEST_FILE.test(f)) selected.add(f);
  // Tests that name a changed file's package by path.
  const touched = new Set(
    graphed.map((f) => packageOf(f, g.dirs)).filter(Boolean)
  );
  const byRef = g.refs
    .filter((x) => !selected.has(x.file) && x.reads.some((q) => touched.has(q)))
    .map((x) => x.file);
  for (const f of byRef) selected.add(f);
  // The baseline changed: every file it names, before and after.
  const byBaseline = graphed.includes(BASELINE)
    ? [...new Set([...g.baseline, ...baseBaseline])].filter(
        (f) => !selected.has(f)
      )
    : [];
  for (const f of byBaseline) selected.add(f);
  const beforeTripwires = selected.size;
  for (const t of g.tripwires) selected.add(t);
  return {
    scope: "selected",
    tests: [...selected].sort(),
    e2e,
    why: [
      graphed.length
        ? `changed: ${graphed.length} file(s)`
        : "no package source changed",
      `${fromGraph} test file(s) the change reaches through imports or reads by path (scripts/ci/import-graph.mjs)`,
      ...(byRef.length
        ? [`${byRef.length} test file(s) that name a changed package by path`]
        : []),
      ...(byBaseline.length
        ? [`${byBaseline.length} file(s) the known-red baseline names`]
        : []),
      `${selected.size - beforeTripwires} more: every tripwire (${g.tripwires.length})`,
      ...(neutral.length
        ? [
            `read by no test: ${neutral.length} generated file(s) under docs/reference/`,
          ]
        : []),
    ],
  };
}

// ── THE PACKAGE TIER (before lane L8) ────────────────────────────────────────
// What a PR ran until lane L8: the touched packages, every workspace package
// that depends on them, and the test files of other packages that read them
// by path. PRs no longer run it. scripts/ci/culprit-finder.mjs still asks it
// "may this PR have made that file fail?": a wider reach than the file-level
// selection, so an attribution it cannot settle goes to the bisect instead of
// being called a flake.

/** Non-test files of these packages reach everything in the package tier. */
export const PACKAGE_TIER_FULL = [
  "packages/database",
  "packages/types",
  "packages/core",
];

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
 * The package tier of changed paths: { scope: "full" | "affected", dirs (the
 * packages whose whole suite it reaches), tests (test files of OTHER packages
 * that read them by path) }. `graph` = loadGraph().graph, `refs` its refs.
 */
export function selectPackageTier(files, { graph, refs = [] }) {
  const dirs = [...graph.keys()];
  const touched = new Set();
  const testOnly = new Set();
  for (const f of files) {
    if (SUITE_NEUTRAL.some((re) => re.test(f))) continue;
    const pkg = packageOf(f, dirs);
    if (!pkg) return { scope: "full", dirs: [], tests: [] };
    if (TEST_FILE.test(f)) testOnly.add(pkg);
    else if (PACKAGE_TIER_FULL.includes(pkg))
      return { scope: "full", dirs: [], tests: [] };
    else touched.add(pkg);
  }
  const affected = new Set([...closure(touched, graph), ...testOnly]);
  const tests = refs
    .filter((r) => !affected.has(r.pkg) && r.reads.some((q) => affected.has(q)))
    .map((r) => r.file)
    .sort();
  return { scope: "affected", dirs: [...affected].sort(), tests };
}
