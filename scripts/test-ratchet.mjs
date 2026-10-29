#!/usr/bin/env node
/**
 * TEST RATCHET — the Full suite gate. Main may not get worse, and the list of
 * known-red test files may only shrink.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * On 2026-10-20 backend main's Full suite failed on ~147 test files. A job that
 * is always red protects nothing: the 148th failure lands unseen. Founder
 * decision 4 (2026-10-20): "make main green, then release from main". This
 * script is the first half: it freezes today's red set in a committed baseline
 * (`scripts/test-ratchet-baseline.txt`, one line per file, with an owner and a
 * cause) and fails on any change that is not an improvement.
 *
 * ── WHAT IT RUNS ─────────────────────────────────────────────────────────────
 * ONE run of every suite, recorded per file through vitest's JSON reporter:
 *   - every workspace package whose `test` script is `vitest run …` (DERIVED
 *     from pnpm-workspace.yaml's globs — a new package joins by existing), run
 *     with that script's own arguments, in its own directory;
 *   - every tripwire file (scripts/tripwire-discovery.mjs) that no package run
 *     reached — e.g. apps/api and the repo root have no `test` script — run per
 *     owning directory, exactly as `pnpm tripwires` does.
 *
 * ── WHAT FAILS IT ────────────────────────────────────────────────────────────
 *   new-failure     a file failed that is not in the baseline
 *   fixed           a baseline file now passes — "remove it from the baseline"
 *   stale-baseline  a baseline file did not run at all (deleted, renamed, or its
 *                   package stopped running) — an entry nobody can ever clear.
 *                   Judged only for packages THIS invocation ran (the e2e job's
 *                   entries are not the Full suite's); a missing file is stale
 *                   everywhere.
 *   no-report       a package produced no parseable JSON (the suite crashed)
 *   vacuous         fewer files than PLAUSIBLE_MIN_FILES ran, a package ran 0
 *                   files without `--passWithNoTests`, or every test of a
 *                   package was skipped (0 passed of N)
 *   below-floor     a package passed fewer tests than its floor in
 *                   scripts/test-floors.json (entries with no `args` only),
 *                   or a floored package did not run at all
 *   tripwire-unrun  a discovered tripwire file appears in no report
 *
 * A file FAILS when vitest reports it `failed` OR it collected zero tests (an
 * import error or a bad `vi.mock` makes a file test nothing — vitest does not
 * count that as a failed test; see test-floor.mjs class 2).
 *
 * ── FLAKE RETRY (scripts/test-ratchet-retry.mjs) ─────────────────────────────
 * Whatever runs the tests (a shard, a full run, the e2e lane) re-runs each NEW
 * failure (red, not in the baseline) ONCE, in the same job, under its package's
 * own flags, and writes a `<report id>#retry` report beside the first. The
 * judge reads both: a file that passed on the retry is `[flaky]` — listed in
 * the summary (and the CI step summary), never counted, never silently green;
 * a file that failed twice, or that the retry did not report, is red as before.
 * More than MAX_RETRY_FILES new failures are not retried (a real break).
 *
 * ── WHAT IT DOES NOT SEE (measured, not implied) ─────────────────────────────
 * Granularity is the FILE. A baseline file that fails 1 test today and 9
 * tomorrow stays "expected red". Burn the list down; do not grow files in it.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node scripts/test-ratchet.mjs                 run everything, then check
 *   node scripts/test-ratchet.mjs --only=packages/api,packages/jobs
 *   node scripts/test-ratchet.mjs --select=selection.json [--shard=k/N]
 *                                                 the PR tier since lane L8
 *                                                 (ci-changes.mjs writes the
 *                                                 file, scope "selected"): the
 *                                                 planned test files, in the
 *                                                 planned shards; see
 *                                                 selectMode() below
 *   node scripts/test-ratchet.mjs --reports=DIR --select=selection.json
 *                                                 judge a selection's shards
 *   node scripts/test-ratchet.mjs --script=test:e2e --only=packages/test-e2e
 *                                                 a lane run by its own CI job
 *                                                 (the package script to read;
 *                                                 default `test`)
 *   node scripts/test-ratchet.mjs --reports=DIR   check reports from an earlier
 *                                                 run (no tests are run)
 *   node scripts/test-ratchet.mjs --record        rewrite the baseline from this
 *                                                 run (keeps owner/cause/note of
 *                                                 surviving entries)
 *   node scripts/test-ratchet.mjs --shard=2/4     run shard 2 of 4 and write its
 *                                                 reports; judges nothing (see
 *                                                 test-ratchet-shards.mjs)
 *   node scripts/test-ratchet.mjs --reports=DIR --shards=4
 *                                                 judge the reports of 4 shards
 *                                                 as one run
 *   TEST_RATCHET_CONCURRENCY=2                    packages run at once
 * Reports land in coverage/test-ratchet/ (CI uploads coverage/).
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTripwires } from "./tripwire-discovery.mjs";
import {
  API_FILES_REPORT,
  SHARDED_DIRS,
  loadShardPlan,
  mergeShardReports,
  soloRuns,
  parseShard,
  planFits,
  runsForShard,
  selectRunArgs,
  selectionProblems,
  shardDoneId,
  shardReportId,
} from "./test-ratchet-shards.mjs";
import {
  MAX_RETRY_FILES,
  applyRetry,
  newFailures,
  retryArgs,
  retryReportId,
} from "./test-ratchet-retry.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "test-ratchet-baseline.txt");
const FLOORS_PATH = join(REPO_ROOT, "scripts", "test-floors.json");
const DEFAULT_REPORTS = join(REPO_ROOT, "coverage", "test-ratchet");

// Measured 2026-10-21 on the devbox: 2,500+ files run. A run below this many
// files lost whole packages (a glob, a config, a crashed runner) and proves
// little. Lower it only with a measured reason.
const PLAUSIBLE_MIN_FILES = 2000;

const args = process.argv.slice(2);
const flag = (name) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const RECORD = args.includes("--record");
const REPORTS_IN = flag("reports");
// --select=<selection.json>: the PR tier since lane L8 (ci-changes.mjs writes
// it, scope "selected"): a list of test files, planned into shards. No
// package suite runs whole; see selectMode() below. An unreadable selection
// throws: the shard or the judge fails, it never runs something else.
const SELECT_PATH = flag("select") ?? process.env.TEST_RATCHET_SELECT;
const SELECTION = SELECT_PATH
  ? JSON.parse(readFileSync(resolve(SELECT_PATH), "utf8"))
  : null;
if (SELECTION && (flag("only") || RECORD))
  throw new Error("--select is its own scope: no --only or --record");
const ONLY =
  flag("only")?.split(",").filter(Boolean) ?? (SELECTION ? [] : undefined);
const SCRIPT = flag("script") ?? "test";
const SHARD = parseShard(flag("shard"));
const SHARDS = flag("shards") ? Number(flag("shards")) : null;
if (SHARD && (REPORTS_IN || RECORD))
  throw new Error("--shard runs one shard; it cannot judge or --record");
const CONCURRENCY = Number(process.env.TEST_RATCHET_CONCURRENCY ?? 2);
const IN_CI = process.env.GITHUB_ACTIONS === "true";

// ── baseline ─────────────────────────────────────────────────────────────────
// Format, one entry per line:  <repo-relative file> | <owner> | <cause> | <note>
// Blank lines and `#` comments are ignored.
function parseBaseline(text) {
  const entries = new Map();
  const problems = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const [file, owner, cause, ...note] = line.split("|").map((s) => s.trim());
    if (!file || !owner || !cause) {
      problems.push(`line ${i + 1}: needs "file | owner | cause | note"`);
      return;
    }
    if (owner === "?" || cause === "?") {
      problems.push(`line ${i + 1}: ${file} has no owner/cause yet (\`?\`)`);
    }
    if (entries.has(file)) problems.push(`line ${i + 1}: duplicate ${file}`);
    entries.set(file, { file, owner, cause, note: note.join(" | ") });
  });
  return { entries, problems };
}

// ── per-file verdict from a vitest JSON report ───────────────────────────────
function classifyReport(report) {
  const files = new Map();
  for (const f of report.testResults ?? []) {
    const rel = relative(REPO_ROOT, f.name).replaceAll("\\", "/");
    const tests = f.assertionResults ?? [];
    const failed = f.status === "failed";
    const empty = tests.length === 0;
    const reason = failed
      ? firstLine(
          f.message ||
            tests.find((t) => t.status === "failed")?.failureMessages?.[0] ||
            "failed"
        )
      : empty
        ? "collected zero tests"
        : "";
    files.set(rel, { ok: !failed && !empty, reason });
  }
  return {
    files,
    total: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
  };
}

// ANSI colour codes (ESC [ … m), built without a control character literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function firstLine(s) {
  return String(s)
    .replace(ANSI, "")
    .replaceAll(`${REPO_ROOT}/`, "")
    .split("\n")[0]
    .slice(0, 160);
}

// Self-check: the classifier must still see the three shapes it hunts. A
// refactor that makes it read every file as passing would otherwise turn this
// whole gate green over anything.
{
  const probe = classifyReport({
    testResults: [
      {
        name: join(REPO_ROOT, "a.test.ts"),
        status: "failed",
        message: "boom",
        assertionResults: [],
      },
      {
        name: join(REPO_ROOT, "b.test.ts"),
        status: "passed",
        assertionResults: [],
      },
      {
        name: join(REPO_ROOT, "c.test.ts"),
        status: "passed",
        assertionResults: [{ status: "passed" }],
      },
    ],
  }).files;
  if (
    probe.get("a.test.ts")?.ok !== false ||
    probe.get("b.test.ts")?.ok !== false ||
    probe.get("c.test.ts")?.ok !== true
  ) {
    console.error(
      "✗ test-ratchet self-check: classifyReport no longer tells failed/empty/passed apart."
    );
    process.exit(2);
  }
}

// ── what to run ──────────────────────────────────────────────────────────────
function workspaceDirs() {
  const yaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s+-\s+"?([^"\n]+?)\/\*"?\s*$/gm)].map(
    (m) => m[1]
  );
  if (globs.length === 0)
    throw new Error("no package globs found in pnpm-workspace.yaml");
  const dirs = [];
  for (const g of globs) {
    const base = join(REPO_ROOT, g);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(base, d.name, "package.json")))
        dirs.push(`${g}/${d.name}`);
    }
  }
  return dirs.sort();
}

function packageRuns() {
  const runs = [];
  const skipped = [];
  for (const dir of workspaceDirs()) {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")
    );
    const script = pkg.scripts?.[SCRIPT];
    if (!script) continue;
    const m = script.match(/^vitest run(?:\s+(.*))?$/);
    if (!m) {
      skipped.push(
        `${dir} (${SCRIPT} script is not \`vitest run …\`: ${script})`
      );
      continue;
    }
    const scriptArgs = m[1] ? m[1].split(/\s+/) : [];
    runs.push({
      id: dir,
      dir,
      args: scriptArgs,
      allowEmpty: scriptArgs.includes("--passWithNoTests"),
    });
  }
  return { runs, skipped };
}

function runVitest(run, outFile) {
  return new Promise((resolveRun) => {
    const argv = [
      "vitest",
      "run",
      ...run.args,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${outFile}`,
    ];
    const started = Date.now();
    const child = spawn("npx", argv, {
      cwd: join(REPO_ROOT, run.dir),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      if (IN_CI) console.log(`::group::${run.id} (exit ${code}, ${secs}s)`);
      else console.log(`\n─── ${run.id} (exit ${code}, ${secs}s) ───`);
      process.stdout.write(log);
      if (IN_CI) console.log("::endgroup::");
      resolveRun();
    });
  });
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, size) }, async () => {
      while (queue.length) await fn(queue.shift());
    })
  );
}

const reportFile = (dir, id) =>
  join(dir, `${id.replace(/[^a-z0-9]+/gi, "_")}.json`);

function readReport(dir, id) {
  try {
    return JSON.parse(readFileSync(reportFile(dir, id), "utf8"));
  } catch {
    return null;
  }
}

// A sharded package's report is its N shard reports merged; one missing shard
// makes the whole package a `no-report`. Only the PACKAGE run is sharded:
// shard 1 runs the tripwires that no package run reaches (the repo root's, a
// package with no `vitest run` script) as one `tripwires:<dir>` report.
const isShardedRun = (run) =>
  !!SHARDS && SHARDED_DIRS.includes(run.dir) && run.id === run.dir;
function readRunReport(dir, run) {
  if (isShardedRun(run))
    return mergeShardReports(
      Array.from({ length: SHARDS }, (_, i) =>
        readReport(dir, shardReportId(run.id, i + 1))
      )
    );
  return readReport(dir, run.id);
}

// The retry reports of a run (one per shard for a sharded package; any may be
// absent: only the shards with new failures retried). null when there is none.
function readRetryReport(dir, run) {
  const ids = isShardedRun(run)
    ? Array.from({ length: SHARDS }, (_, i) =>
        retryReportId(shardReportId(run.id, i + 1))
      )
    : [retryReportId(run.id)];
  const found = ids.map((id) => readReport(dir, id)).filter(Boolean);
  return found.length
    ? { testResults: found.flatMap((r) => r.testResults ?? []) }
    : null;
}

const tripwireOwner = (file) =>
  file.match(/^((?:packages|apps)\/[^/]+)\//)?.[1] ?? ".";

// ── main ─────────────────────────────────────────────────────────────────────
const inScope = (path) =>
  !ONLY || ONLY.some((d) => path === d || path.startsWith(`${d}/`));
const { runs: allRuns, skipped } = packageRuns();
const runs = allRuns.filter((r) => inScope(r.dir));

// The tripwires in scope run on their own, under their package's config,
// wherever no package run reaches them. Shard 1 runs them; the judge expects
// their reports.
const discovered = discoverTripwires(REPO_ROOT).map((f) =>
  relative(REPO_ROOT, f)
);
const mustRun = discovered.filter(inScope).sort();
const mustRunSet = new Set(mustRun);
const reportsDir = REPORTS_IN ? resolve(REPORTS_IN) : DEFAULT_REPORTS;
mkdirSync(reportsDir, { recursive: true });

// The baseline is read before anything runs: the flake retry needs to know
// which failures are new.
const baselineText = existsSync(BASELINE_PATH)
  ? readFileSync(BASELINE_PATH, "utf8")
  : "";
const { entries: baseline, problems: parseProblems } =
  parseBaseline(baselineText);

// A retry report left by an earlier run in the same directory must never
// vouch for this one: each run deletes its retry report before it starts.
const clearRetry = (list) => {
  for (const r of list)
    rmSync(reportFile(reportsDir, retryReportId(r.reportId ?? r.id)), {
      force: true,
    });
};

// Re-run each NEW failure of the runs just executed, once, under the run's own
// flags (scripts/test-ratchet-retry.mjs). The judge reads the retry reports.
async function retryNewFailures(executed) {
  const plan = [];
  for (const r of executed) {
    const id = r.reportId ?? r.id;
    const report = readReport(reportsDir, id);
    if (!report) continue;
    const files = newFailures(classifyReport(report).files, baseline);
    if (files.length) plan.push({ r, id, files });
  }
  const total = plan.reduce((n, p) => n + p.files.length, 0);
  if (total === 0) return;
  if (total > MAX_RETRY_FILES) {
    console.log(
      `\ntest-ratchet: ${total} new failure(s), more than ${MAX_RETRY_FILES}: not retried (that many at once is a real break, not a flake).`
    );
    return;
  }
  console.log(
    `\ntest-ratchet: retrying ${total} new failure(s) once: ${plan.flatMap((p) => p.files).join(", ")}`
  );
  await pool(plan, CONCURRENCY, (p) =>
    runVitest(
      {
        id: `${p.id} (retry)`,
        dir: p.r.dir,
        args: retryArgs(
          p.r.args,
          p.files.map((f) => (p.r.dir === "." ? f : relative(p.r.dir, f)))
        ),
      },
      reportFile(reportsDir, retryReportId(p.id))
    )
  );
}

// Every test file of a package, as vitest itself resolves them (its own
// include/exclude), relative to the package; null when the listing fails (or,
// unless `emptyIsList`, when it lists nothing).
function listVitestFiles(run, { emptyIsList = false } = {}) {
  const out = join(
    reportsDir,
    `${run.id.replace(/[^a-z0-9]+/gi, "_")}.vitest-list.json`
  );
  return new Promise((done) => {
    const child = spawn(
      "npx",
      ["vitest", "list", "--filesOnly", `--json=${out}`, ...run.args],
      { cwd: join(REPO_ROOT, run.dir), env: process.env, stdio: "ignore" }
    );
    child.on("error", () => done(null));
    child.on("close", (code) => {
      try {
        if (code !== 0) throw new Error(`exit ${code}`);
        const base = join(REPO_ROOT, run.dir);
        const files = JSON.parse(readFileSync(out, "utf8")).map((e) =>
          relative(base, e.file).replaceAll("\\", "/")
        );
        done(files.length || emptyIsList ? files.sort() : null);
      } catch {
        done(null);
      }
    });
  });
}

// ── the PR selection (--select) ──────────────────────────────────────────────
// The plan (scripts/test-ratchet-shards.mjs planSelection) names every run:
// { id, dir, shard, files }. A shard lists each of its runs with vitest's own
// include/exclude first (`<id>.list.json`: the files vitest would collect, or
// null when listing failed), runs the ones that collect something, retries new
// failures once, and writes `select-shard-<k>.done.json`. The judge reads the
// same plan and is red on: a broken plan (a tripwire planned nowhere), a shard
// with no done marker, a run with no report (unless its listing was empty), a
// planned file that vitest collected (or could not list) but no report holds,
// a tripwire in no report, a new failure, a fixed or stale baseline entry of
// a planned file. A planned file its package's config does not collect is
// listed, not red: main's full suite does not run it either.
async function selectMode() {
  const scriptArgs = new Map(allRuns.map((r) => [r.dir, r.args]));
  const planned = SELECTION.runs.map((r) => ({
    id: r.id,
    dir: r.dir,
    shard: r.shard,
    files: r.files,
    args: selectRunArgs(r, scriptArgs.get(r.dir) ?? []),
    allowEmpty: true,
  }));
  const listPath = (id) =>
    join(reportsDir, `${id.replace(/[^a-z0-9]+/gi, "_")}.list.json`);
  if (!REPORTS_IN) {
    if (SHARD && SHARD.n !== SELECTION.shards)
      throw new Error(
        `--shard=${SHARD.k}/${SHARD.n} but the selection plans ${SELECTION.shards} shard(s)`
      );
    const ks = SHARD
      ? [SHARD.k]
      : Array.from({ length: SELECTION.shards }, (_, i) => i + 1);
    const mine = planned.filter((r) => ks.includes(r.shard));
    clearRetry(mine);
    const toRun = [];
    for (const r of mine) {
      const listed = await listVitestFiles(r, { emptyIsList: true });
      const repoRel = listed?.map((f) => (r.dir === "." ? f : `${r.dir}/${f}`));
      // Nothing collected: does the package's config collect anything at
      // all? Main's full mode is red on a package that runs 0 files.
      let packageListed;
      if (repoRel && repoRel.length === 0 && scriptArgs.has(r.dir)) {
        const all = await listVitestFiles(
          { ...r, id: `${r.id}#package`, args: scriptArgs.get(r.dir) },
          { emptyIsList: true }
        );
        packageListed = all ? all.length : null;
      }
      writeFileSync(
        listPath(r.id),
        `${JSON.stringify({ listed: repoRel ?? null, ...(packageListed !== undefined ? { packageListed } : {}) })}\n`
      );
      if (repoRel && repoRel.length === 0) continue;
      rmSync(reportFile(reportsDir, r.id), { force: true });
      toRun.push(r);
    }
    console.log(
      `test-ratchet: selection of ${SELECTION.tests.length} file(s) in ${SELECTION.shards} shard(s); running ${toRun.length} of ${mine.length} planned run(s)${SHARD ? ` (shard ${SHARD.k}/${SHARD.n})` : ""}, ${CONCURRENCY} at a time`
    );
    await pool(toRun, CONCURRENCY, (r) =>
      runVitest(r, reportFile(reportsDir, r.id))
    );
    await retryNewFailures(toRun);
    for (const k of ks)
      writeFileSync(
        join(reportsDir, `${shardDoneId(k)}.json`),
        `${JSON.stringify({ shard: k, runs: mine.filter((r) => r.shard === k).map((r) => r.id) })}\n`
      );
    if (SHARD) {
      console.log(
        `\ntest-ratchet: shard ${SHARD.k}/${SHARD.n} done; reports in ${relative(REPO_ROOT, reportsDir)}. The "Full suite" job judges them.`
      );
      process.exit(0);
    }
  }

  const problems = [];
  for (const p of selectionProblems(SELECTION, discovered))
    problems.push({ kind: "selection", detail: p });
  for (let k = 1; k <= SELECTION.shards; k++)
    if (!existsSync(join(reportsDir, `${shardDoneId(k)}.json`)))
      problems.push({
        kind: "no-report",
        detail: `shard ${k}/${SELECTION.shards} wrote no done marker (${shardDoneId(k)}.json): it crashed or never ran`,
      });
  const results = new Map();
  const flaky = [];
  const perRun = [];
  const notCollected = [];
  const unrun = [];
  for (const r of planned) {
    let listed = null;
    let packageListed = null;
    try {
      const l = JSON.parse(readFileSync(listPath(r.id), "utf8"));
      listed = l.listed;
      packageListed = l.packageListed ?? null;
    } catch {
      // no listing: the shard did not reach this run; its report decides
    }
    if (Array.isArray(listed) && listed.length === 0) {
      notCollected.push(...r.files);
      // A package whose config collects nothing at all is red, as in the
      // full mode (unless its script passes with no tests); a listing that
      // failed is red too, never a guess.
      const args = scriptArgs.get(r.dir);
      if (args && packageListed !== null && packageListed > 0) continue;
      if (args && packageListed === 0 && args.includes("--passWithNoTests"))
        continue;
      if (args)
        problems.push({
          kind: "vacuous",
          detail: `${r.dir}: its vitest config ${packageListed === 0 ? "collects 0 test files" : "could not be listed"} (${r.id} planned ${r.files.length} file(s)); main's full suite is red on this too`,
        });
      continue;
    }
    const report = readReport(reportsDir, r.id);
    if (!report) {
      problems.push({
        kind: "no-report",
        detail: `${r.id}: no report (shard ${r.shard} crashed before it, or the suite crashed before reporting). Reproduce: cd ${r.dir} && npx vitest run ${r.args.length > 8 ? `<${r.args.length} args>` : r.args.join(" ")}`,
      });
      continue;
    }
    const first = classifyReport(report);
    const retry = readReport(reportsDir, retryReportId(r.id));
    const retried = applyRetry(
      first.files,
      retry ? classifyReport(retry).files : null,
      baseline
    );
    for (const fl of retried.flaky) flaky.push({ ...fl, run: r.id });
    // A file two runs reached (vitest's filters are substrings): any red wins,
    // a later green never overwrites it.
    for (const [f, v] of retried.files)
      if (results.get(f)?.ok !== false) results.set(f, v);
    // A run with tests and not one passing: skipped (no database) or broken.
    // A run of known-red baseline files only is exempt (they fail on main).
    if (
      first.total > 0 &&
      first.passed === 0 &&
      [...first.files.keys()].some((f) => !baseline.has(f))
    )
      problems.push({
        kind: "vacuous",
        detail: `${r.id}: 0 of ${first.total} tests passed — every test skipped or failed. Is Postgres up and migrated (DATABASE_URL)?`,
      });
    perRun.push({
      id: r.id,
      dir: r.dir,
      files: retried.files.size,
      failedFiles: [...retried.files.values()].filter((v) => !v.ok).length,
      passed: first.passed,
      total: first.total,
    });
    const listedSet = Array.isArray(listed) ? new Set(listed) : null;
    for (const f of r.files)
      if (!retried.files.has(f))
        (listedSet && !listedSet.has(f) ? notCollected : unrun).push(f);
  }
  if (unrun.length)
    problems.push({
      kind: "select-unrun",
      detail: `${unrun.length} planned test file(s) that vitest collects (or could not list) appear in no report:\n${unrun
        .slice(0, 20)
        .map((f) => `      ${f}`)
        .join("\n")}`,
    });
  const twUnrun = discovered.filter((t) => !results.has(t));
  if (twUnrun.length)
    problems.push({
      kind: "tripwire-unrun",
      detail: `${twUnrun.length} tripwire file(s) appear in no report (every PR runs every tripwire):\n${twUnrun
        .slice(0, 20)
        .map((f) => `      ${f}`)
        .join("\n")}`,
    });
  if (discovered.length < 100)
    problems.push({
      kind: "vacuous",
      detail: `only ${discovered.length} tripwire files discovered (326 on 2026-10-21) — did the naming convention or the walk change?`,
    });
  const plannedSet = new Set(planned.flatMap((r) => r.files));
  const failing = [...results].filter(([, v]) => !v.ok);
  const newRed = failing.filter(([f]) => !baseline.has(f));
  const fixed = [];
  const stale = [];
  for (const [f] of baseline) {
    if (!existsSync(join(REPO_ROOT, f))) {
      stale.push(f);
      continue;
    }
    if (!plannedSet.has(f) || notCollected.includes(f)) continue;
    const r = results.get(f);
    if (r?.ok) fixed.push(f);
  }
  // A PR's FULL tier, planned as a selection: the full mode's floors hold too
  // (a config that stops collecting tests must not read green).
  if (SELECTION.full) {
    if (results.size < PLAUSIBLE_MIN_FILES)
      problems.push({
        kind: "vacuous",
        detail: `only ${results.size} test files ran (floor ${PLAUSIBLE_MIN_FILES}). Whole packages went missing.`,
      });
    const floors = JSON.parse(readFileSync(FLOORS_PATH, "utf8")).entries.filter(
      (e) => !e.args && typeof e.floor === "number"
    );
    for (const e of floors) {
      const mine = perRun.filter((x) => x.dir === e.dir);
      const passed = mine.reduce((n, x) => n + x.passed, 0);
      if (passed < e.floor)
        problems.push({
          kind: "below-floor",
          detail: `${e.dir}: ${passed} passing${mine.length ? "" : " (it did not run)"}, floor ${e.floor} (scripts/test-floors.json).`,
        });
    }
  }
  for (const p of parseProblems)
    problems.push({ kind: "baseline-format", detail: p });
  if (newRed.length)
    problems.push({
      kind: "new-failure",
      detail: `${newRed.length} file(s) fail that are not in the baseline (failed twice where a retry ran). Fix them; the baseline is not a place to park new red:\n${newRed.map(([f, v]) => `      ${f}\n        ↳ ${v.reason}`).join("\n")}`,
    });
  if (fixed.length)
    problems.push({
      kind: "fixed",
      detail: `${fixed.length} baseline file(s) now pass — remove them from scripts/test-ratchet-baseline.txt so they can never regress unseen:\n${fixed.map((f) => `      ${f}`).join("\n")}`,
    });
  if (stale.length)
    problems.push({
      kind: "stale-baseline",
      detail: `${stale.length} baseline file(s) no longer exist — remove them:\n${stale.map((f) => `      ${f}`).join("\n")}`,
    });

  console.log(
    "\n─── test ratchet (PR selection) ──────────────────────────────"
  );
  for (const r of perRun)
    console.log(
      `  ${r.id.padEnd(44)} ${String(r.files).padStart(5)} files  ${String(r.failedFiles).padStart(4)} red  ${String(r.passed).padStart(6)}/${r.total} tests passed`
    );
  console.log(
    `  ${results.size} files ran of ${plannedSet.size} planned in ${SELECTION.shards} shard(s), ${failing.length} red, ${discovered.length} tripwires discovered${flaky.length ? `, ${flaky.length} flaky` : ""}`
  );
  if (notCollected.length)
    console.log(
      `\n  [not-collected] ${notCollected.length} planned file(s) their package's vitest config does not collect (main's full suite does not run them either):\n${notCollected
        .slice(0, 20)
        .map((f) => `      ${f}`)
        .join("\n")}`
    );
  if (SELECTION.dropped?.length)
    console.log(
      `\n  [no-suite] ${SELECTION.dropped.length} selected file(s) in a dir with no \`vitest run\` suite (run nowhere, on main either):\n${SELECTION.dropped
        .slice(0, 20)
        .map((f) => `      ${f}`)
        .join("\n")}`
    );
  if (flaky.length) {
    console.log(
      `\n  [flaky]\n      ${flaky.length} file(s) failed, then passed when re-run alone in the same job. Not counted; own and fix them:\n${flaky.map((f) => `      ${f.file}\n        ↳ first run: ${f.firstReason}`).join("\n")}`
    );
    if (IN_CI)
      for (const f of flaky)
        console.log(
          `::warning file=${f.file},title=Flaky test file::failed, then passed on the retry (not counted). First run: ${f.firstReason}`
        );
  }
  if (problems.length === 0) {
    console.log(
      `\n✓ test ratchet OK — every planned file ran, every red file is a known, owned baseline entry.\n`
    );
    process.exit(0);
  }
  console.error(`\n✗ TEST RATCHET — ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  [${p.kind}]\n      ${p.detail}\n`);
  process.exit(1);
}
if (SELECTION) await selectMode();

let executed = [];
if (!REPORTS_IN) {
  let shardOpts = {};
  if (SHARD) {
    // By measured time when the committed plan fits (test-ratchet-shards.mjs).
    const plan = loadShardPlan();
    const apiRun = runs.find((r) => SHARDED_DIRS.includes(r.dir));
    let apiFiles = null;
    if (planFits(plan, SHARD.n) && apiRun) {
      apiFiles = await listVitestFiles(apiRun);
      if (apiFiles)
        writeFileSync(
          join(reportsDir, API_FILES_REPORT),
          `${JSON.stringify({ dir: apiRun.dir, files: apiFiles })}\n`
        );
    }
    console.log(
      apiFiles
        ? `test-ratchet: shard plan of ${plan.generatedAt?.slice(0, 10)} (scripts/ci/shard-plan.json), ${apiFiles.length} ${apiRun.dir} files listed`
        : `test-ratchet: no usable shard plan${plan ? " (plan does not fit or vitest list failed)" : ""}: vitest --shard=${SHARD.k}/${SHARD.n} by count, other packages in shard 1`
    );
    shardOpts = { plan, apiFiles };
  }
  const toRun = runsForShard(runs, SHARD, shardOpts);
  console.log(
    `test-ratchet: ${toRun.length} package suite(s)${SHARD ? ` (shard ${SHARD.k}/${SHARD.n})` : ""}, ${CONCURRENCY} at a time`
  );
  for (const s of skipped) console.log(`  not run: ${s}`);
  // Longest first, so the slowest suite never starts last.
  const order = [...toRun].sort((a, b) =>
    a.dir === "packages/api" ? -1 : b.dir === "packages/api" ? 1 : 0
  );
  clearRetry(order);
  await pool(order, CONCURRENCY, (r) =>
    runVitest(r, reportFile(reportsDir, r.reportId ?? r.id))
  );
  executed = order;
}

// A shard only runs and writes reports; the "Full suite" job judges them all.
// Shard 1 also runs the tripwires no package owns (the repo root's), under the
// same report ids the judge derives (`tripwires:<dir>`). The judge derives that
// set from what the merged reports reached; a package config that EXCLUDES its
// own tripwire would make the judge expect a report shard 1 never wrote, and it
// goes red as `no-report` — loud, never silently green.
if (SHARD) {
  if (SHARD.k === 1) {
    // A package that runs in this invocation (in some shard) reaches its own
    // files; every other must-run file runs here.
    const tripwireShardRuns = soloRuns(
      mustRun,
      runs.map((r) => r.dir)
    );
    clearRetry(tripwireShardRuns);
    await pool(tripwireShardRuns, CONCURRENCY, (r) =>
      runVitest(r, reportFile(reportsDir, r.id))
    );
    executed = executed.concat(tripwireShardRuns);
  }
  await retryNewFailures(executed);
  console.log(
    `\ntest-ratchet: shard ${SHARD.k}/${SHARD.n} done; reports in ${relative(REPO_ROOT, reportsDir)}. The "Full suite" job judges them.`
  );
  process.exit(0);
}
if (!REPORTS_IN) await retryNewFailures(executed);

const problems = [];
const results = new Map(); // repo-relative file → { ok, reason }
const perRun = [];
const flaky = []; // { file, firstReason, run } — failed, then passed on the retry
const collect = (run) => {
  const report = readRunReport(reportsDir, run);
  if (!report) {
    const sharded = isShardedRun(run);
    problems.push({
      kind: "no-report",
      detail: `${run.id}: ${sharded ? `at least one of its ${SHARDS} shard reports is missing — a shard crashed or never ran` : "the runner produced no parseable JSON — the suite crashed before reporting"}. Reproduce: cd ${run.dir} && npx vitest run ${run.args.length > 8 ? `<${run.args.length} args>` : run.args.join(" ")}`,
    });
    return;
  }
  const first = classifyReport(report);
  const retry = readRetryReport(reportsDir, run);
  const retried = applyRetry(
    first.files,
    retry ? classifyReport(retry).files : null,
    baseline
  );
  for (const fl of retried.flaky) flaky.push({ ...fl, run: run.id });
  const c = { ...first, files: retried.files };
  for (const [f, v] of c.files) results.set(f, v);
  const failedFiles = [...c.files.values()].filter((v) => !v.ok).length;
  perRun.push({
    id: run.id,
    files: c.files.size,
    failedFiles,
    passed: c.passed,
    total: c.total,
  });
  if (c.files.size === 0 && !run.allowEmpty) {
    problems.push({ kind: "vacuous", detail: `${run.id}: ran 0 test files.` });
  }
  if (c.total > 0 && c.passed === 0) {
    problems.push({
      kind: "vacuous",
      detail: `${run.id}: 0 of ${c.total} tests passed — every test skipped or failed. Is Postgres up and migrated (DATABASE_URL)?`,
    });
  }
};
runs.forEach(collect);

// Tripwires no package run reached (packages without a `test` script, the
// repo root). Run them where they live, like `pnpm tripwires` does.
const tripwires = mustRun;
if (!ONLY && discovered.length < 100) {
  problems.push({
    kind: "vacuous",
    detail: `only ${discovered.length} tripwire files discovered (326 on 2026-10-21) — did the naming convention or the walk change?`,
  });
}
const unreached = new Map();
for (const t of tripwires) {
  if (results.has(t)) continue;
  const dir = tripwireOwner(t);
  if (!unreached.has(dir)) unreached.set(dir, []);
  unreached.get(dir).push(dir === "." ? t : t.slice(dir.length + 1));
}
const tripwireRuns = [...unreached].map(([dir, files]) => ({
  id: `tripwires:${dir}`,
  dir,
  args: files,
  allowEmpty: false,
}));
if (!REPORTS_IN && tripwireRuns.length) {
  clearRetry(tripwireRuns);
  await pool(tripwireRuns, CONCURRENCY, (r) =>
    runVitest(r, reportFile(reportsDir, r.id))
  );
  await retryNewFailures(tripwireRuns);
}
tripwireRuns.forEach(collect);
// A tripwire that ran nowhere is red.
const unrun = tripwires.filter((t) => !results.has(t));
if (unrun.length) {
  problems.push({
    kind: "tripwire-unrun",
    detail: `${unrun.length} tripwire file(s) appear in no report (excluded by their package's vitest config?):\n${unrun.map((f) => `      ${f}`).join("\n")}`,
  });
}

// A planned split must run every file it planned from: a file the plan gave to
// no shard (or a shard that fell back to another split) is red, never unrun.
if (SHARDS) {
  let listed = null;
  try {
    listed = JSON.parse(
      readFileSync(join(reportsDir, API_FILES_REPORT), "utf8")
    );
  } catch {
    // no planned shard wrote a list: the shards split by vitest's own --shard
  }
  if (listed) {
    const unrunApi = listed.files
      .map((f) => `${listed.dir}/${f}`)
      .filter((f) => inScope(f) && !results.has(f));
    if (unrunApi.length)
      problems.push({
        kind: "shard-unrun",
        detail: `${unrunApi.length} ${listed.dir} test file(s) were listed by the shards but appear in no shard report (the shard plan gave them no shard, or a shard fell back to another split):\n${unrunApi
          .slice(0, 20)
          .map((f) => `      ${f}`)
          .join("\n")}`,
      });
  }
}

// Non-vacuity of the whole run.
if (!ONLY && results.size < PLAUSIBLE_MIN_FILES) {
  problems.push({
    kind: "vacuous",
    detail: `only ${results.size} test files ran (floor ${PLAUSIBLE_MIN_FILES}). Whole packages went missing.`,
  });
}

// Floors (test-floors.json entries that run the package's own config).
const floors = JSON.parse(readFileSync(FLOORS_PATH, "utf8")).entries.filter(
  (e) => !e.args && typeof e.floor === "number"
);
for (const e of floors) {
  const r = perRun.find((p) => p.id === e.dir);
  // A floored package that did not run at all lost its `test` script (or it
  // stopped being `vitest run …`): its whole suite left CI with no red. (One
  // that ran and crashed is already a `no-report`.)
  if (
    !r &&
    SCRIPT === "test" &&
    inScope(e.dir) &&
    !runs.some((x) => x.dir === e.dir)
  ) {
    problems.push({
      kind: "below-floor",
      detail: `${e.dir}: did not run, floor ${e.floor} (scripts/test-floors.json). Its \`test\` script is gone or is not \`vitest run …\`.`,
    });
  } else if (r && r.passed < e.floor) {
    problems.push({
      kind: "below-floor",
      detail: `${e.dir}: ${r.passed} passing, floor ${e.floor} (scripts/test-floors.json). Tests stopped running or started failing.`,
    });
  }
}

// The ratchet itself (the baseline was read before the runs).
for (const p of parseProblems)
  problems.push({ kind: "baseline-format", detail: p });

// One baseline serves several CI jobs (Full suite runs `test`, API e2e runs
// `test:e2e`). An entry belongs to THIS invocation only when its package is one
// this invocation ran; another job's entries are neither stale nor dropped here.
// What this cannot see: a package that loses its script entirely takes its
// entries out of every job's view — the floors and PLAUSIBLE_MIN_FILES catch
// the lost tests, not this check.
const ranDirs = new Set([...runs, ...tripwireRuns].map((r) => r.dir));
const ownerDir = (file) =>
  [...ranDirs]
    .filter((d) => d !== "." && file.startsWith(`${d}/`))
    .sort((a, b) => b.length - a.length)[0] ??
  (ranDirs.has(".") && !/^(packages|apps)\//.test(file) ? "." : null);
const ownedHere = (file) =>
  (inScope(file) || mustRunSet.has(file)) && ownerDir(file) !== null;

const failing = [...results].filter(([, v]) => !v.ok);
const newRed = failing.filter(([f]) => !baseline.has(f));
const fixed = [];
const stale = [];
for (const [f] of baseline) {
  // A deleted or renamed file is stale for every job, owned here or not.
  if (!existsSync(join(REPO_ROOT, f))) {
    stale.push(f);
    continue;
  }
  if (!ownedHere(f)) continue;
  const r = results.get(f);
  if (!r) stale.push(f);
  else if (r.ok) fixed.push(f);
}

if (RECORD) {
  const lines = failing
    .map(([f, v]) => {
      const prev = baseline.get(f);
      return prev
        ? `${f} | ${prev.owner} | ${prev.cause} | ${prev.note}`
        : `${f} | ? | ? | ${v.reason.replaceAll("|", "/")}`;
    })
    .concat(
      [...baseline.values()]
        .filter((e) => !ownedHere(e.file))
        .map((e) => `${e.file} | ${e.owner} | ${e.cause} | ${e.note}`)
    )
    .sort();
  const header = baselineText
    .split("\n")
    .filter((l) => l.startsWith("#"))
    .join("\n");
  writeFileSync(BASELINE_PATH, `${header}\n${lines.join("\n")}\n`);
  console.log(
    `\nRecorded ${lines.length} failing file(s) → ${relative(REPO_ROOT, BASELINE_PATH)}`
  );
  process.exit(0);
}

if (newRed.length) {
  problems.push({
    kind: "new-failure",
    detail: `${newRed.length} file(s) fail that are not in the baseline (failed twice where a retry ran). Fix them; the baseline is not a place to park new red:\n${newRed.map(([f, v]) => `      ${f}\n        ↳ ${v.reason}`).join("\n")}`,
  });
}
if (fixed.length) {
  problems.push({
    kind: "fixed",
    detail: `${fixed.length} baseline file(s) now pass — remove them from scripts/test-ratchet-baseline.txt so they can never regress unseen:\n${fixed.map((f) => `      ${f}`).join("\n")}`,
  });
}
if (stale.length) {
  problems.push({
    kind: "stale-baseline",
    detail: `${stale.length} baseline file(s) did not run at all (deleted, renamed, or no longer collected) — remove them:\n${stale.map((f) => `      ${f}`).join("\n")}`,
  });
}

console.log("\n─── test ratchet ─────────────────────────────────────────────");
for (const r of perRun) {
  console.log(
    `  ${r.id.padEnd(34)} ${String(r.files).padStart(5)} files  ${String(r.failedFiles).padStart(4)} red  ${String(r.passed).padStart(6)}/${r.total} tests passed`
  );
}
console.log(
  `  ${results.size} files ran, ${failing.length} red, baseline ${baseline.size}, ${tripwires.length} tripwires discovered${flaky.length ? `, ${flaky.length} flaky` : ""}`
);

// Flaky files: red, then green on the retry. Not counted, never hidden: listed
// here, annotated, and written to the CI step summary so someone owns each one.
if (flaky.length) {
  console.log(
    `\n  [flaky]\n      ${flaky.length} file(s) failed, then passed when re-run alone in the same job. Not counted; own and fix them (file a pod finding, as bf1e2ca6 did):\n${flaky.map((f) => `      ${f.file}\n        ↳ first run: ${f.firstReason}`).join("\n")}`
  );
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const runUrl =
    repo && process.env.GITHUB_RUN_ID
      ? `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  if (IN_CI)
    for (const f of flaky)
      console.log(
        `::warning file=${f.file},title=Flaky test file::failed, then passed on the retry (not counted). First run: ${f.firstReason}`
      );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const link = (f) =>
      repo && sha
        ? `[\`${f}\`](${server}/${repo}/blob/${sha}/${f})`
        : `\`${f}\``;
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "### Flaky test files (failed, then passed on the retry; not counted)",
        "",
        "| file | first run | suite |",
        "|---|---|---|",
        ...flaky.map(
          (f) =>
            `| ${link(f.file)} | ${f.firstReason.replace(/\|/g, "\\|")} | ${f.run} |`
        ),
        "",
        `Own each one: file a pod \`finding\` with this run${runUrl ? ` (${runUrl})` : ""} as evidence.`,
        "",
      ].join("\n")
    );
  }
}

if (problems.length === 0) {
  console.log(
    `\n✓ test ratchet OK — every red file is a known, owned baseline entry${flaky.length ? ` (${flaky.length} flaky file(s) listed above, not counted)` : ""}.\n`
  );
  process.exit(0);
}
console.error(`\n✗ TEST RATCHET — ${problems.length} problem(s)\n`);
for (const p of problems) console.error(`  [${p.kind}]\n      ${p.detail}\n`);
process.exit(1);
