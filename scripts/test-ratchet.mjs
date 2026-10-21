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
 *                   scripts/test-floors.json (entries with no `args` only)
 *   tripwire-unrun  a discovered tripwire file appears in no report
 *
 * A file FAILS when vitest reports it `failed` OR it collected zero tests (an
 * import error or a bad `vi.mock` makes a file test nothing — vitest does not
 * count that as a failed test; see test-floor.mjs class 2).
 *
 * ── WHAT IT DOES NOT SEE (measured, not implied) ─────────────────────────────
 * Granularity is the FILE. A baseline file that fails 1 test today and 9
 * tomorrow stays "expected red". Burn the list down; do not grow files in it.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node scripts/test-ratchet.mjs                 run everything, then check
 *   node scripts/test-ratchet.mjs --only=packages/api,packages/jobs
 *   node scripts/test-ratchet.mjs --script=test:e2e --only=packages/test-e2e
 *                                                 a lane run by its own CI job
 *                                                 (the package script to read;
 *                                                 default `test`)
 *   node scripts/test-ratchet.mjs --reports=DIR   check reports from an earlier
 *                                                 run (no tests are run)
 *   node scripts/test-ratchet.mjs --record        rewrite the baseline from this
 *                                                 run (keeps owner/cause/note of
 *                                                 surviving entries)
 *   TEST_RATCHET_CONCURRENCY=2                    packages run at once
 * Reports land in coverage/test-ratchet/ (CI uploads coverage/).
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTripwires } from "./tripwire-discovery.mjs";

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
const ONLY = flag("only")?.split(",").filter(Boolean);
const SCRIPT = flag("script") ?? "test";
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

// ── main ─────────────────────────────────────────────────────────────────────
const inScope = (path) =>
  !ONLY || ONLY.some((d) => path === d || path.startsWith(`${d}/`));
const { runs: allRuns, skipped } = packageRuns();
const runs = allRuns.filter((r) => inScope(r.dir));
const reportsDir = REPORTS_IN ? resolve(REPORTS_IN) : DEFAULT_REPORTS;
mkdirSync(reportsDir, { recursive: true });

if (!REPORTS_IN) {
  console.log(
    `test-ratchet: ${runs.length} package suite(s), ${CONCURRENCY} at a time`
  );
  for (const s of skipped) console.log(`  not run: ${s}`);
  // Longest first, so the slowest suite never starts last.
  const order = [...runs].sort((a, b) =>
    a.dir === "packages/api" ? -1 : b.dir === "packages/api" ? 1 : 0
  );
  await pool(order, CONCURRENCY, (r) =>
    runVitest(r, reportFile(reportsDir, r.id))
  );
}

const problems = [];
const results = new Map(); // repo-relative file → { ok, reason }
const perRun = [];
const collect = (run) => {
  const report = readReport(reportsDir, run.id);
  if (!report) {
    problems.push({
      kind: "no-report",
      detail: `${run.id}: the runner produced no parseable JSON — the suite crashed before reporting. Reproduce: cd ${run.dir} && npx vitest run ${run.args.join(" ")}`,
    });
    return;
  }
  const c = classifyReport(report);
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

// Tripwires no package run reached (packages without a `test` script, the repo
// root). Run them where they live, like `pnpm tripwires` does.
const tripwires = discoverTripwires(REPO_ROOT)
  .map((f) => relative(REPO_ROOT, f))
  .filter(inScope);
if (!ONLY && tripwires.length < 100) {
  problems.push({
    kind: "vacuous",
    detail: `only ${tripwires.length} tripwire files discovered (326 on 2026-10-21) — did the naming convention or the walk change?`,
  });
}
const unreached = new Map();
for (const t of tripwires) {
  if (results.has(t)) continue;
  const m = t.match(/^((?:packages|apps)\/[^/]+)\//);
  const dir = m ? m[1] : ".";
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
  await pool(tripwireRuns, CONCURRENCY, (r) =>
    runVitest(r, reportFile(reportsDir, r.id))
  );
}
tripwireRuns.forEach(collect);
const unrun = tripwires.filter((t) => !results.has(t));
if (unrun.length) {
  problems.push({
    kind: "tripwire-unrun",
    detail: `${unrun.length} tripwire file(s) appear in no report (excluded by their package's vitest config?):\n${unrun.map((f) => `      ${f}`).join("\n")}`,
  });
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
  if (r && r.passed < e.floor) {
    problems.push({
      kind: "below-floor",
      detail: `${e.dir}: ${r.passed} passing, floor ${e.floor} (scripts/test-floors.json). Tests stopped running or started failing.`,
    });
  }
}

// The ratchet itself.
const baselineText = existsSync(BASELINE_PATH)
  ? readFileSync(BASELINE_PATH, "utf8")
  : "";
const { entries: baseline, problems: parseProblems } =
  parseBaseline(baselineText);
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
const ownedHere = (file) => inScope(file) && ownerDir(file) !== null;

const failing = [...results].filter(([, v]) => !v.ok);
const newFailures = failing.filter(([f]) => !baseline.has(f));
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

if (newFailures.length) {
  problems.push({
    kind: "new-failure",
    detail: `${newFailures.length} file(s) fail that are not in the baseline. Fix them; the baseline is not a place to park new red:\n${newFailures.map(([f, v]) => `      ${f}\n        ↳ ${v.reason}`).join("\n")}`,
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
  `  ${results.size} files ran, ${failing.length} red, baseline ${baseline.size}, ${tripwires.length} tripwires discovered`
);

if (problems.length === 0) {
  console.log(
    "\n✓ test ratchet OK — every red file is a known, owned baseline entry.\n"
  );
  process.exit(0);
}
console.error(`\n✗ TEST RATCHET — ${problems.length} problem(s)\n`);
for (const p of problems) console.error(`  [${p.kind}]\n      ${p.detail}\n`);
process.exit(1);
