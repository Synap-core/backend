#!/usr/bin/env node
/**
 * shard-plan.mjs — balance the Full suite's shards by measured time and write
 * scripts/ci/shard-plan.json (read by scripts/test-ratchet-shards.mjs).
 *
 * ── WHERE THE TIMES COME FROM ────────────────────────────────────────────────
 * The shards' own vitest JSON reports (the `ratchet-shard-*` artifacts every
 * CI run uploads, kept 7 days), from the last few runs whose 4 shard jobs all
 * succeeded:
 *   - another package (packages/database, packages/jobs …) runs whole in one
 *     vitest process: its cost is that report's wall clock, from the report's
 *     `startTime` to its last file's `endTime`;
 *   - a packages/api test file: vitest's per-file `startTime`/`endTime` cover
 *     its tests only, not its import and setup, which dominate here (a shard's
 *     per-file sum is ~40 % of its wall). So the file's cost is rebuilt from
 *     the worker timeline: W = the most files ever running at once, and each
 *     file, in start order, follows the worker that freed up last before it
 *     started; its cost is its end minus that worker's previous end (setup and
 *     import included). Measured on run 40768837227: the rebuilt costs sum to
 *     88-93 % of each shard's wall (the rest is vitest start-up and the tail).
 * Each cost is the MEDIAN over the runs read; a file seen in no run gets the
 * median file cost.
 *
 * ── HOW IT SPLITS ────────────────────────────────────────────────────────────
 * Longest processing time first (LPT): items sorted by cost, longest first,
 * ties by name; each goes to the shard with the least load so far, ties to the
 * lowest shard. Items: every packages/api file (cost / W: W workers share the
 * shard's api run) and every other package (its wall). That counts the other
 * packages as if they ran after packages/api; they actually run beside it
 * (TEST_RATCHET_CONCURRENCY=2) on the same 4 vCPUs. Measured 2026-10-28 (old
 * split, shard 1 = a quarter of packages/api + every other package): the model
 * said ~2,020 s, the step took a median 1,531 s; shards 2-4 (api only) took
 * 670-830 s for ~600 s modelled. So the additive model is a ceiling, and its
 * error is largest for the shard holding packages/database (840 s alone): the
 * plan's real balance is read from the CI run, not from `predictedSeconds`.
 * Deterministic: same reports, same plan.
 * The repo-root tripwires stay in shard 1 (1 s).
 *
 * ── REFRESH ──────────────────────────────────────────────────────────────────
 * Weekly, with check-scores.json:  node scripts/ci/shard-plan.mjs
 * A file added since is placed by a hash of its path until then.
 *
 * Usage:
 *   node scripts/ci/shard-plan.mjs [--runs=3] [--shards=4] [--repo=Synap-core/backend]
 *   node scripts/ci/shard-plan.mjs --reports=DIR [...]   DIR holds ratchet-shard-*
 *                                                        folders of one or more runs
 *                                                        (DIR/<run>/ratchet-shard-k/)
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const OUT = join(HERE, "shard-plan.json");
const API_DIR = "packages/api";

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Most files running at once in one report (the worker count, as observed). */
export function observedWorkers(testResults) {
  const ev = [];
  for (const t of testResults) {
    if (!t.startTime || !t.endTime) continue;
    ev.push([t.startTime, 1], [t.endTime, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) max = Math.max(max, (cur += d));
  return Math.max(1, max);
}

/**
 * Per-file cost in seconds, setup and import included, rebuilt from the worker
 * timeline of one vitest report (see the header). Map absolute path → seconds.
 */
export function fileCosts(report) {
  const files = (report.testResults ?? [])
    .filter((t) => t.startTime && t.endTime)
    .sort((a, b) => a.startTime - b.startTime || (a.name < b.name ? -1 : 1));
  const W = observedWorkers(files);
  const free = Array(W).fill(report.startTime ?? files[0]?.startTime ?? 0);
  const out = new Map();
  for (const t of files) {
    let best = -1;
    for (let i = 0; i < W; i++)
      if (free[i] <= t.startTime && (best < 0 || free[i] > free[best]))
        best = i;
    if (best < 0) best = free.indexOf(Math.min(...free));
    const from = Math.min(free[best], t.startTime);
    out.set(t.name, (t.endTime - from) / 1000);
    free[best] = t.endTime;
  }
  return { costs: out, workers: W };
}

/** Wall clock of one whole-package report, in seconds (0 for an empty one). */
export function reportWall(report) {
  const ends = (report.testResults ?? []).map((t) => t.endTime).filter(Boolean);
  if (!ends.length || !report.startTime) return 0;
  return (Math.max(...ends) - report.startTime) / 1000;
}

/** LPT: items [{key, cost}] into n shards. Returns { assign: Map key → k, loads }. */
export function lpt(items, n) {
  const loads = Array(n).fill(0);
  const assign = new Map();
  const sorted = [...items].sort(
    (a, b) => b.cost - a.cost || (a.key < b.key ? -1 : 1)
  );
  for (const it of sorted) {
    let k = 0;
    for (let i = 1; i < n; i++) if (loads[i] < loads[k]) k = i;
    loads[k] += it.cost;
    assign.set(it.key, k + 1);
  }
  return { assign, loads };
}

/** The report files of one run's artifacts: Map reportBase → parsed JSON. */
function readRunReports(runDir) {
  const out = new Map();
  for (const shardDir of readdirSync(runDir).filter((d) =>
    d.startsWith("ratchet-shard-")
  )) {
    for (const f of readdirSync(join(runDir, shardDir))) {
      if (
        !f.endsWith(".json") ||
        f.endsWith(".list.json") ||
        f === "api-files.json"
      )
        continue;
      try {
        out.set(
          f.replace(/\.json$/, ""),
          JSON.parse(readFileSync(join(runDir, shardDir, f), "utf8"))
        );
      } catch {
        // a torn report is not a measurement
      }
    }
  }
  return out;
}

/**
 * The plan from the reports of several runs. `runs` is [{ id, reports: Map }].
 * Report ids follow test-ratchet.mjs: `packages_api_shard<k>`, `<dir with _>`.
 */
export function buildPlan(runs, { shards, packageDirs, apiRoot }) {
  const apiCosts = new Map(); // rel path → [seconds per run]
  const pkgWalls = new Map(); // dir → [seconds per run]
  const workers = [];
  for (const run of runs) {
    for (const [id, report] of run.reports) {
      if (/^packages_api_shard\d+(_retry)?$/.test(id)) {
        if (id.endsWith("_retry")) continue;
        const { costs, workers: w } = fileCosts(report);
        workers.push(w);
        for (const [abs, s] of costs) {
          const rel = relative(apiRoot, abs).replaceAll("\\", "/");
          // A CI path (/home/runner/work/backend/backend/packages/api/...) is
          // re-rooted by its "packages/api/" segment.
          const key = rel.startsWith("..")
            ? abs.split(`/${API_DIR}/`).pop()
            : rel;
          if (!apiCosts.has(key)) apiCosts.set(key, []);
          apiCosts.get(key).push(s);
        }
        continue;
      }
      const dir = packageDirs.find(
        (d) => d.replace(/[^a-z0-9]+/gi, "_") === id
      );
      if (!dir || dir === API_DIR) continue;
      if (!pkgWalls.has(dir)) pkgWalls.set(dir, []);
      pkgWalls.get(dir).push(reportWall(report));
    }
  }
  const W = workers.length ? median(workers) : 1;
  const items = [
    ...[...apiCosts].map(([f, xs]) => ({
      key: `api:${f}`,
      cost: median(xs) / W,
    })),
    ...[...pkgWalls].map(([d, xs]) => ({ key: `pkg:${d}`, cost: median(xs) })),
  ];
  const { assign, loads } = lpt(items, shards);
  const api = {};
  for (const [f, xs] of [...apiCosts].sort(([a], [b]) => (a < b ? -1 : 1)))
    api[f] = [assign.get(`api:${f}`), Number(median(xs).toFixed(2))];
  const packages = {};
  const packageSeconds = {};
  for (const [d, xs] of [...pkgWalls].sort(([a], [b]) => (a < b ? -1 : 1))) {
    packages[d] = assign.get(`pkg:${d}`);
    packageSeconds[d] = Number(median(xs).toFixed(1));
  }
  return {
    shards,
    apiWorkers: W,
    predictedSeconds: loads.map((l) => Math.round(l)),
    packages,
    packageSeconds,
    api,
  };
}

function workspaceDirs() {
  const yaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s+-\s+"?([^"\n]+?)\/\*"?\s*$/gm)].map(
    (m) => m[1]
  );
  const dirs = [];
  for (const g of globs) {
    const base = join(REPO_ROOT, g);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true }))
      if (d.isDirectory() && existsSync(join(base, d.name, "package.json")))
        dirs.push(`${g}/${d.name}`);
  }
  return dirs.sort();
}

function gh(argv) {
  return execFileSync("gh", argv, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The latest completed CI runs whose 4 shard jobs all succeeded. */
function recentShardRuns(repo, want) {
  const runs = JSON.parse(
    gh([
      "api",
      `repos/${repo}/actions/workflows/ci.yml/runs?status=completed&per_page=50`,
    ])
  ).workflow_runs;
  const out = [];
  for (const r of runs) {
    if (out.length >= want) break;
    const jobs = JSON.parse(
      gh(["api", `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`])
    ).jobs;
    const shardJobs = jobs.filter((j) =>
      /^Full suite \(shard \d+\/\d+\)$/.test(j.name)
    );
    if (
      shardJobs.length >= 2 &&
      shardJobs.every((j) => j.conclusion === "success")
    )
      out.push(r.id);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) =>
    argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
  const shards = Number(flag("shards", "4"));
  const repo = flag("repo", "Synap-core/backend");
  let root = flag("reports");
  let runIds;
  if (!root) {
    runIds = recentShardRuns(repo, Number(flag("runs", "3")));
    if (!runIds.length)
      throw new Error("no recent run with all shard jobs green");
    root = mkdtempSync(join(tmpdir(), "shard-plan-"));
    for (const id of runIds) {
      console.error(`shard-plan: downloading the shard reports of run ${id}`);
      gh([
        "run",
        "download",
        String(id),
        "-R",
        repo,
        "-p",
        "ratchet-shard-*",
        "-D",
        join(root, String(id)),
      ]);
    }
  } else {
    runIds = readdirSync(root).filter(
      (d) => existsSync(join(root, d)) && !d.startsWith("ratchet-shard-")
    );
    if (!runIds.length) runIds = ["."];
  }
  const runs = runIds.map((id) => ({
    id,
    reports: readRunReports(join(root, String(id))),
  }));
  const plan = buildPlan(runs, {
    shards,
    packageDirs: workspaceDirs(),
    apiRoot: join(REPO_ROOT, API_DIR),
  });
  const doc = {
    generatedAt: new Date().toISOString(),
    generatedBy: "node scripts/ci/shard-plan.mjs",
    refresh: "weekly, with scripts/ci/check-scores.json",
    fromRuns: runIds.map(String),
    model:
      "LPT over packages/api files (rebuilt worker-timeline cost / workers) and whole packages (report wall); see the script header",
    ...plan,
  };
  // One line per value: a refresh diffs as one changed line per moved file.
  const lines = Object.entries(doc).map(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? `  ${JSON.stringify(k)}: {\n${Object.entries(v)
          .map(([f, x]) => `    ${JSON.stringify(f)}: ${JSON.stringify(x)}`)
          .join(",\n")}\n  }`
      : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`
  );
  writeFileSync(OUT, `{\n${lines.join(",\n")}\n}\n`);
  console.log(
    `shard-plan: ${Object.keys(plan.api).length} ${API_DIR} files, ${Object.keys(plan.packages).length} packages, ${shards} shards; predicted seconds per shard: ${plan.predictedSeconds.join(" / ")}`
  );
  for (let k = 1; k <= shards; k++)
    console.log(
      `  shard ${k}: ${Object.values(plan.api).filter(([s]) => s === k).length} api files + ${
        Object.entries(plan.packages)
          .filter(([, s]) => s === k)
          .map(([d]) => d)
          .join(", ") || "no other package"
      }`
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
