/**
 * test-ratchet-shards.mjs — split the Full suite across parallel CI jobs.
 *
 * Measured 2026-10-27 (Full suite job 122274134527): of the ratchet's ~38 min,
 * packages/api (1,950 files) was the whole critical path. So packages/api is
 * split across the shards, and the other packages run whole, one shard each.
 *
 * ── BY MEASURED TIME, NOT BY COUNT (2026-10-28) ──────────────────────────────
 * Until 28 Oct packages/api was split by vitest's `--shard=k/N` (an equal COUNT
 * of files, by path hash) and every other package ran in shard 1. Over the
 * last 50 PR runs the "Test (shard k/4)" step took a median 25.5 / 13.9 / 13.2
 * / 11.2 min: shard 1 carried every other package (packages/database alone is
 * ~10 min) beside its quarter of packages/api, and the slowest shard is the
 * verdict time. Now a committed plan (scripts/ci/shard-plan.json, written by
 * scripts/ci/shard-plan.mjs from the shards' own vitest reports) gives every
 * packages/api test file and every other package a shard, balanced by measured
 * time. Recompute it weekly, like check-scores.json.
 *
 * Deterministic and fail-safe:
 *   - a packages/api test file the plan does not name (a new file) goes to a
 *     shard by a stable hash of its path; a planned file that no longer exists
 *     is dropped; the file list comes from `vitest list --filesOnly`, i.e. the
 *     package's own include/exclude, never a second glob;
 *   - a package the plan does not name runs in shard 1, as before;
 *   - no plan, a plan for another shard count, or a failed `vitest list` →
 *     vitest's own `--shard=k/N`, as before.
 * Each shard writes the full file list it planned from (`api-files.json`); the
 * judge checks that every one of those files is in some shard's report, so a
 * file assigned to no shard is red (`shard-unrun`), never silently unrun.
 *
 * Each shard job writes its reports; one final job ("Full suite") reads them
 * all with `test-ratchet.mjs --reports=DIR --shards=N` and judges exactly as a
 * single run would. A missing shard report reads as no report: the judge goes
 * red (`no-report`), never green on a partial run.
 *
 * Self-contained (node: built-ins only) so the judge job needs no `pnpm install`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Packages split across shards file by file; every other package runs whole. */
export const SHARDED_DIRS = ["packages/api"];

export const SHARD_PLAN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "ci",
  "shard-plan.json"
);

/** The report file a shard writes with the packages/api files it planned from. */
export const API_FILES_REPORT = "api-files.json";

/** "2/4" → { k: 2, n: 4 }; undefined → null; anything else throws. */
export function parseShard(value) {
  if (value === undefined) return null;
  const m = /^(\d+)\/(\d+)$/.exec(value);
  const k = m && Number(m[1]);
  const n = m && Number(m[2]);
  if (!m || n < 1 || k < 1 || k > n)
    throw new Error(`--shard must be k/N with 1 <= k <= N, got "${value}"`);
  return { k, n };
}

/** The committed plan, or null when there is none or it does not parse. */
export function loadShardPlan(path = SHARD_PLAN_PATH) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** A stable shard 1..n for a path (FNV-1a 32-bit): same path, same shard. */
export function hashShard(path, n) {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % n) + 1;
}

/**
 * The shard of each packages/api test file (paths relative to packages/api):
 * the plan's, or a hash for a file the plan does not name. Every file gets
 * exactly one shard.
 *
 * vitest reads a positional argument as a SUBSTRING filter (vitest 4.0,
 * `filterFiles`: `testFile.includes(filter)`), so the argument `src/a.test.ts`
 * also runs `src/x/src/a.test.ts`. A file whose path contains another listed
 * path therefore goes to that file's shard: it runs once, where its filter
 * already reaches it. (None does on 2026-10-28; this keeps it so.)
 */
export function assignApiFiles(files, plan, n) {
  const out = new Map();
  for (const f of files) {
    const planned = plan?.api?.[f]?.[0];
    out.set(
      f,
      Number.isInteger(planned) && planned >= 1 && planned <= n
        ? planned
        : hashShard(f, n)
    );
  }
  const lower = [...out.keys()].map((f) => [f, f.toLowerCase()]);
  for (const [g, gl] of lower) {
    const host = lower.find(([f, fl]) => f !== g && gl.includes(fl));
    if (host) out.set(g, out.get(host[0]));
  }
  return out;
}

/** True when the plan can drive an N-shard run. */
export const planFits = (plan, n) =>
  !!plan && plan.shards === n && !!plan.api && !!plan.packages;

/**
 * The runs one shard executes. `runs` are the ratchet's package runs; `opts`:
 *   plan      the shard plan (loadShardPlan), or null
 *   apiFiles  every packages/api test file (relative to packages/api), or null
 *             when it could not be listed
 * With a fitting plan and a file list, packages/api runs its assigned files
 * and each other package runs in its planned shard. Otherwise the old split:
 * vitest `--shard=k/N` for packages/api, everything else in shard 1.
 */
export function runsForShard(
  runs,
  shard,
  { plan = null, apiFiles = null } = {}
) {
  if (!shard) return runs;
  const byPlan = planFits(plan, shard.n) && Array.isArray(apiFiles);
  const assigned = byPlan ? assignApiFiles(apiFiles, plan, shard.n) : null;
  return runs.flatMap((r) => {
    if (SHARDED_DIRS.includes(r.dir)) {
      const base = { ...r, reportId: shardReportId(r.id, shard.k) };
      if (!byPlan)
        return [
          { ...base, args: [...r.args, `--shard=${shard.k}/${shard.n}`] },
        ];
      const mine = [...assigned]
        .filter(([, k]) => k === shard.k)
        .map(([f]) => f)
        .sort();
      if (mine.length === 0)
        throw new Error(
          `shard plan gives shard ${shard.k}/${shard.n} no ${r.dir} file: regenerate scripts/ci/shard-plan.json`
        );
      return [{ ...base, args: [...r.args, ...mine], planned: true }];
    }
    const k = byPlan ? (plan.packages[r.dir] ?? 1) : 1;
    return k === shard.k ? [r] : [];
  });
}

export const shardReportId = (id, k) => `${id}#shard${k}`;

/** The workspace package that owns a repo-relative file, or "." (the root). */
export const ownerDir = (file) =>
  file.match(/^((?:packages|apps)\/[^/]+)\//)?.[1] ?? ".";

/**
 * The files that run on their own, under their package's config, wherever no
 * package run reaches them (scripts/ci/affected.mjs, the PR tier):
 *   discovered   every tripwire file (repo-relative)
 *   affected     the --affected package dirs, or null (not the PR tier)
 *   also         the --also files: tests of unaffected packages that read an
 *                affected one by path
 *   inScope      the run's scope predicate (--only / --affected)
 *   suiteDirs    the dirs of every package with a `vitest run` test script
 *   exists       file → boolean
 * Under --affected EVERY tripwire runs, plus each --also file whose package
 * has a suite (a test of a package with none runs nowhere, on main either).
 * Otherwise only the in-scope tripwires, as before.
 * Returns { files (sorted), also (the --also files kept) }.
 */
export function mustRunFiles({
  discovered,
  affected,
  also = [],
  inScope,
  suiteDirs,
  exists,
}) {
  if (!affected) return { files: discovered.filter(inScope).sort(), also: [] };
  const suites = new Set(suiteDirs);
  const kept = also.filter(
    (f) => !inScope(f) && exists(f) && suites.has(ownerDir(f))
  );
  return { files: [...new Set([...discovered, ...kept])].sort(), also: kept };
}

/**
 * Shard 1's own runs: the must-run files whose package does not run in this
 * invocation (`runDirs`, any shard), one run per owning dir, under the report
 * id the judge derives (`tripwires:<dir>`), each path relative to its dir.
 */
export function soloRuns(files, runDirs) {
  const owned = new Set(runDirs);
  const byDir = new Map();
  for (const t of files) {
    const dir = ownerDir(t);
    if (owned.has(dir)) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(dir === "." ? t : t.slice(dir.length + 1));
  }
  return [...byDir].map(([dir, args]) => ({
    id: `tripwires:${dir}`,
    dir,
    args,
  }));
}

/**
 * One vitest JSON report from a sharded package's N reports, or null when any
 * shard's report is missing (the suite crashed or the shard never ran).
 */
export function mergeShardReports(reports) {
  if (reports.length === 0 || reports.some((r) => !r)) return null;
  return {
    testResults: reports.flatMap((r) => r.testResults ?? []),
    numTotalTests: reports.reduce((s, r) => s + (r.numTotalTests ?? 0), 0),
    numPassedTests: reports.reduce((s, r) => s + (r.numPassedTests ?? 0), 0),
  };
}

// ── THE PR SELECTION (lane L8, 2026-10-29) ───────────────────────────────────
// A PR runs a list of test files (scripts/ci/affected.mjs, scope "selected"),
// not whole packages. The decision ("What changed") plans it here, before any
// install, and hands the plan to the shards and the judge as one file
// (selection.json): which files, in how many shards, under which report ids.
// The judge reads the same file, so a planned run whose report is missing is
// red, never a partial green.

/** Per-shard test time the plan aims at (s): 2.4 min setup + this ≈ 8-9 min. */
export const SELECTION_BUDGET_SECONDS = 360;
/**
 * The most shards a PR selection may use. A small selection uses 1 (fewer jobs
 * on the org's concurrency, faster queue); a large one up to this. Main and the
 * merge queue keep the committed 4-shard plan.
 */
export const SELECTION_MAX_SHARDS = 8;
/** A package whose selected files cost less than this runs as one item. */
const SPLIT_FLOOR_SECONDS = 60;
/** What one more vitest process costs in a shard (start, config, DB pool). */
export const RUN_OVERHEAD_SECONDS = 8;

export const selectReportId = (dir, k) => `select:${dir}#shard${k}`;
export const shardDoneId = (k) => `select-shard-${k}.done`;

/**
 * The cost (seconds of shard wall) of each test file, from the committed
 * plan: a packages/api file's rebuilt cost over the api workers; a file of
 * another package its package's measured wall over its test-file count
 * (`countByDir`); anything unmeasured, the median packages/api file.
 */
export function fileCost(plan, countByDir) {
  const W = plan?.apiWorkers || 3;
  const api = Object.values(plan?.api ?? {})
    .map((v) => v?.[1])
    .filter((x) => typeof x === "number")
    .sort((a, b) => a - b);
  const medianApi = api.length ? api[Math.floor(api.length / 2)] / W : 2;
  return (file) => {
    const dir = ownerDir(file);
    if (SHARDED_DIRS.includes(dir)) {
      const c = plan?.api?.[file.slice(dir.length + 1)]?.[1];
      return typeof c === "number" ? c / W : medianApi;
    }
    const s = plan?.packageSeconds?.[dir];
    if (typeof s === "number") return s / Math.max(1, countByDir[dir] ?? 1);
    return medianApi;
  };
}

/**
 * Plan a selection. `tests`: the repo-relative test files to run (tripwires
 * included); `suiteDirs`: the packages with a `vitest run` test script;
 * `isTripwire`; `plan`: the committed shard plan (costs); `countByDir`: test
 * files per owning dir in the checkout. Returns
 *   { version, shards, budgetSeconds, predictedSeconds[], runs[{ id, dir,
 *     shard, files }], tests (what runs), dropped (selected files that run
 *     nowhere, on main either: a non-tripwire test of a dir with no suite) }.
 * Deterministic: same input, same plan. Longest processing time first.
 */
export function planSelection({
  tests,
  suiteDirs,
  isTripwire,
  plan = null,
  countByDir = {},
  budgetSeconds = SELECTION_BUDGET_SECONDS,
  maxShards = SELECTION_MAX_SHARDS,
}) {
  const suites = new Set(suiteDirs);
  const cost = fileCost(plan, countByDir);
  const runnable = [];
  const dropped = [];
  for (const f of [...new Set(tests)].sort())
    (suites.has(ownerDir(f)) || isTripwire(f) ? runnable : dropped).push(f);
  const byDir = new Map();
  for (const f of runnable) {
    const d = ownerDir(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  // Items: a big package's files one by one; a small package as one item.
  const items = [];
  for (const [dir, files] of byDir) {
    const total = files.reduce((s, f) => s + cost(f), 0);
    if (total < SPLIT_FLOOR_SECONDS)
      items.push({ dir, files, cost: total, key: dir });
    else
      for (const f of files)
        items.push({ dir, files: [f], cost: cost(f), key: f });
  }
  const total =
    items.reduce((s, i) => s + i.cost, 0) + byDir.size * RUN_OVERHEAD_SECONDS;
  const shards = Math.max(
    1,
    Math.min(maxShards, Math.ceil(total / budgetSeconds))
  );
  items.sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
  const load = Array.from({ length: shards }, () => 0);
  const runsOf = Array.from({ length: shards }, () => new Map());
  for (const it of items) {
    let k = 0;
    for (let i = 1; i < shards; i++) if (load[i] < load[k]) k = i;
    const runs = runsOf[k];
    if (!runs.has(it.dir)) {
      runs.set(it.dir, []);
      load[k] += RUN_OVERHEAD_SECONDS;
    }
    runs.get(it.dir).push(...it.files);
    load[k] += it.cost;
  }
  const runs = [];
  runsOf.forEach((m, i) => {
    for (const [dir, files] of [...m].sort(([a], [b]) => a.localeCompare(b)))
      runs.push({
        id: selectReportId(dir, i + 1),
        dir,
        shard: i + 1,
        files: files.sort(),
      });
  });
  return {
    version: 1,
    shards,
    budgetSeconds,
    predictedSeconds: load.map((s) => Math.round(s)),
    runs,
    tests: runnable,
    dropped,
  };
}

/**
 * The vitest argv of a planned run: its package's own test-script flags and
 * its files relative to the run's dir (the root runs files only). vitest reads
 * a file argument as a SUBSTRING filter, so a run may also reach an unplanned
 * file whose path contains a planned one: it runs, and is judged, as an extra.
 */
export function selectRunArgs(run, scriptArgs = []) {
  return [
    ...scriptArgs,
    ...run.files.map((f) =>
      run.dir === "." ? f : f.slice(run.dir.length + 1)
    ),
  ];
}

/**
 * Problems with a selection file; the judge is red on any (it never judges a
 * plan that dropped a tripwire or names a run it cannot match to a shard).
 */
export function selectionProblems(sel, tripwires) {
  if (!sel || sel.version !== 1) return ["not a version-1 selection"];
  const out = [];
  if (!Number.isInteger(sel.shards) || sel.shards < 1)
    out.push(`shards is ${sel.shards}`);
  if (!Array.isArray(sel.runs)) return [...out, "no runs"];
  const planned = new Set(sel.runs.flatMap((r) => r.files ?? []));
  const missing = tripwires.filter((t) => !planned.has(t));
  if (missing.length)
    out.push(
      `${missing.length} tripwire(s) planned in no run (every PR runs every tripwire): ${missing.slice(0, 5).join(", ")}`
    );
  for (const r of sel.runs)
    if (
      !(r.shard >= 1 && r.shard <= sel.shards) ||
      r.id !== selectReportId(r.dir, r.shard)
    )
      out.push(`run ${r.id} does not match its dir and shard`);
  return out;
}
