#!/usr/bin/env node
/**
 * check-scores.mjs — measure what each CI check costs and how often it is the
 * red, from the last few hundred completed runs, and write
 * scripts/ci/check-scores.json.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * On 2026-10-28 one merge took ~4 h: five CI runs of 22-34 min in a row, each
 * finding ONE new red, none caused by the PR under test. The fix is to run the
 * cheap checks that are likely to be red first, before the 20-minute jobs, and
 * to report all of them at once (scripts/preflight.mjs). Which checks those are
 * is MEASURED here, not guessed.
 *
 * ── THE FORMULA (prior-art brief, pod document da67c51b, §7) ─────────────────
 *   c_i   median wall-clock minutes of unit i over the last 30 PR runs where it
 *         ran, setup included, queue wait excluded (job started_at → completed_at;
 *         the Full suite unit runs from its first shard's start to the judge's end).
 *   p_i   (f_i + 1) / (n_i + 2) (Laplace) over the last ~50 PR runs where it ran
 *         to a verdict. A failure counts in f_i only when
 *           - it is the run's LATEST attempt (a red that a re-run turned green
 *             did not survive the retry), and
 *           - main was not red on the same unit at that time (the latest
 *             completed main push run started before this run): a red that is
 *             also main's is exonerated, as the Chromium CQ's "without patch"
 *             step does.
 *   score = p_i / c_i, descending.
 * A UNIT is a set of checks that share one setup: a job, and the Full suite's
 * 4 shards + judge as ONE unit (they share the install and the ratchet). Steps
 * and test files are listed too, inside their unit, so the preflight can read
 * the p of the exact check it mirrors; their c is the step's own duration (a
 * test file has none: it runs inside "Test (shard k/4)").
 *
 * NOT COUNTED as a run with a verdict: cancelled runs, skipped jobs, negctl/*
 * branches, and a job whose failing step is a HOLD ("Suites not run …",
 * "Never merges (negctl)", "Preflight red …"): a hold reports red on purpose,
 * it measures nothing.
 *
 * NOT YET MEASURED (no history): "every earlier tier passed" — the preflight
 * tier is new, so p_i is over all PR runs today. Once preflight has a month of
 * history, condition p on preflight green.
 *
 * ── REFRESH ──────────────────────────────────────────────────────────────────
 * Weekly (prior-art brief rule 4): `node scripts/ci/check-scores.mjs` and
 * commit the JSON. A check whose p_i stays under ~0.1 % for a quarter is a
 * candidate to leave the PR path for the main baseline.
 *
 * Usage:
 *   node scripts/ci/check-scores.mjs [--runs=400] [--repo=Synap-core/backend]
 *                                    [--out=scripts/ci/check-scores.json]
 * Needs `gh` logged in with read access to the repo's Actions.
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;

const REPO = flag("repo", "Synap-core/backend");
const MAX_RUNS = Number(flag("runs", "400"));
const OUT = resolve(flag("out", join(HERE, "check-scores.json")));
const COST_WINDOW = 30;
const P_WINDOW = 50;
// reference-docs.yml: the "Reference docs are current" job until 2026-10-28 (now
// in ci.yml); its runs still count for that unit until they age out.
const WORKFLOWS = ["ci.yml", "reference-docs.yml"];

// A failing step with one of these names is a hold: red on purpose.
export const HOLD_STEP =
  /^(Suites not run|Never merges \(negctl\)|Preflight red)/;
// The runner's own bookkeeping steps and the uploads/teardown after the
// checks: not checks. (Ranked, their tiny cost let the Laplace prior of a step
// that never failed outrank every real check.)
const BOOKKEEPING =
  /^(Set up job|Complete job|Post |Run actions\/|Stop containers|Initialize containers|Upload |API log$|Save the turbo cache$)/;
// Setup steps (checkout, token, toolchain, install): listed with their own p (an
// install can fail), ranked after the checks: no preflight can run them sooner.
export const SETUP_STEP =
  /› (Checkout|Mint|Setup|Get pnpm|Install|Lay out|Collect|Monorepo layout|Migrate|Build the|Start the|Reader App access|Run [\w.-]+\/[\w.-]+@)/;
// Fewer runs than this and p is mostly the Laplace prior: listed, ranked last.
const MIN_SAMPLE = 10;

// The Full suite's shards and judge are one unit, and so are the Release
// gate's parallel parts ("Release gate: lint", … since 2026-10-29) and its
// judge; every other job is its own.
export const unitOf = (jobName) =>
  /^Full suite( \(shard \d+\/\d+\))?$/.test(jobName)
    ? "Full suite"
    : /^Release gate(: .+)?$/.test(jobName)
      ? "Release gate"
      : jobName;

// The job half of a step's key. A Release gate part keeps the key its step had
// in the single job ("Release gate › Lint"), so the rows of runs before and
// after the split are one row, and the preflight's `mirrors` still find them.
export const stepOwner = (jobName) =>
  unitOf(jobName) === "Release gate" ? "Release gate" : jobName;

export const laplace = (f, n) => (f + 1) / (n + 2);
export const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const secs = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;

/** The ratchet judge's `[new-failure]` files, from its job log text. */
export function parseNewFailures(log) {
  const lines = log
    .split("\n")
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""));
  const out = new Set();
  let inBlock = false;
  for (const l of lines) {
    if (/^\s{2}\[[a-z-]+\]\s*$/.test(l)) {
      inBlock = l.trim() === "[new-failure]";
      continue;
    }
    if (!inBlock) continue;
    const m = /^\s{6}(\S+\.test\.[cm]?[jt]sx?)\s*$/.exec(l);
    if (m) out.add(m[1]);
    else if (/^\S/.test(l)) inBlock = false;
  }
  return [...out];
}

// Self-check: the parser must still read the judge's real output shape.
{
  const probe = parseNewFailures(
    [
      "2026-10-28T21:26:19.1Z ✗ TEST RATCHET — 1 problem(s)",
      "2026-10-28T21:26:19.1Z   [new-failure]",
      "2026-10-28T21:26:19.1Z       1 file(s) fail that are not in the baseline.",
      "2026-10-28T21:26:19.1Z       packages/api/src/x.freshness.test.ts",
      "2026-10-28T21:26:19.1Z         ↳ AssertionError: boom",
      "2026-10-28T21:26:19.1Z   [fixed]",
      "2026-10-28T21:26:19.1Z       packages/api/src/y.test.ts",
    ].join("\n")
  );
  if (probe.join() !== "packages/api/src/x.freshness.test.ts") {
    console.error(
      "✗ check-scores self-check: parseNewFailures misread the judge log"
    );
    process.exit(2);
  }
}

async function gh(path, { raw = false } = {}) {
  const argv = ["api", path];
  if (raw) argv.push("-H", "Accept: application/vnd.github.raw");
  const { stdout } = await run("gh", argv, { maxBuffer: 256 * 1024 * 1024 });
  return raw ? stdout : JSON.parse(stdout);
}

async function pool(items, size, fn) {
  const queue = [...items];
  const out = [];
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) {
        const item = queue.shift();
        out.push(await fn(item));
      }
    })
  );
  return out;
}

async function listRuns(workflow) {
  const runs = [];
  for (let page = 1; runs.length < MAX_RUNS && page <= 10; page++) {
    let r;
    try {
      r = await gh(
        `repos/${REPO}/actions/workflows/${workflow}/runs?status=completed&per_page=100&page=${page}`
      );
    } catch (err) {
      // A workflow file removed from the default branch may no longer resolve
      // by name: its history is then simply not read.
      console.error(`check-scores: ${workflow}: ${err.message.split("\n")[0]}`);
      break;
    }
    runs.push(...r.workflow_runs);
    if (r.workflow_runs.length < 100) break;
  }
  return runs.slice(0, MAX_RUNS).map((r) => ({
    id: r.id,
    workflow,
    event: r.event,
    branch: r.head_branch,
    conclusion: r.conclusion,
    attempt: r.run_attempt,
    started: r.run_started_at,
    sha: r.head_sha,
  }));
}

async function jobsOf(r) {
  const j = await gh(`repos/${REPO}/actions/runs/${r.id}/jobs?per_page=100`);
  return j.jobs.map((job) => ({
    id: job.id,
    name: job.name,
    conclusion: job.conclusion,
    started: job.started_at,
    completed: job.completed_at,
    steps: (job.steps ?? [])
      .filter((s) => !BOOKKEEPING.test(s.name))
      .map((s) => ({
        name: s.name,
        conclusion: s.conclusion,
        started: s.started_at,
        completed: s.completed_at,
      })),
  }));
}

/**
 * One record per (run, unit) and per (run, job › step) with a verdict.
 * Pure: takes the runs with their jobs, returns the observations.
 */
export function observe(runs) {
  const units = [];
  const steps = [];
  for (const r of runs) {
    const byUnit = new Map();
    for (const job of r.jobs) {
      if (job.conclusion === "skipped" || job.conclusion === "cancelled")
        continue;
      const failedStep = job.steps.find((s) => s.conclusion === "failure");
      const hold = failedStep && HOLD_STEP.test(failedStep.name);
      for (const s of job.steps) {
        if (s.conclusion !== "success" && s.conclusion !== "failure") continue;
        if (HOLD_STEP.test(s.name)) continue;
        if (!s.started || !s.completed) continue;
        steps.push({
          run: r,
          key: `${stepOwner(job.name)} › ${s.name}`,
          unit: unitOf(job.name),
          failed: s.conclusion === "failure",
          secs: Math.max(0, secs(s.started, s.completed)),
        });
      }
      if (hold) continue;
      const u = unitOf(job.name);
      const cur = byUnit.get(u) ?? {
        started: job.started,
        completed: job.completed,
        failed: false,
        failedSteps: [],
      };
      if (Date.parse(job.started) < Date.parse(cur.started))
        cur.started = job.started;
      if (Date.parse(job.completed) > Date.parse(cur.completed))
        cur.completed = job.completed;
      if (job.conclusion === "failure") {
        cur.failed = true;
        if (failedStep)
          cur.failedSteps.push(`${stepOwner(job.name)} › ${failedStep.name}`);
      }
      byUnit.set(u, cur);
    }
    for (const [unit, u] of byUnit)
      units.push({
        run: r,
        key: unit,
        failed: u.failed,
        failedSteps: u.failedSteps,
        secs: Math.max(0, secs(u.started, u.completed)),
      });
  }
  return { units, steps };
}

const isPr = (r) =>
  r.event === "pull_request" && !r.branch?.startsWith("negctl/");
const isMain = (r) => r.event === "push" && r.branch === "main";

/** main's latest completed run of the same workflow that started before `r`. */
export function mainBefore(r, mainRuns) {
  return mainRuns
    .filter(
      (m) =>
        m.workflow === r.workflow &&
        Date.parse(m.started) < Date.parse(r.started)
    )
    .sort((a, b) => Date.parse(b.started) - Date.parse(a.started))[0];
}

/**
 * Score one key from its observations (newest first). `redOnMain(obs)` says
 * whether main was red on the same key when that run started.
 */
export function score(obs, redOnMain) {
  const pr = obs.filter((o) => isPr(o.run));
  const costWin = pr.slice(0, COST_WINDOW);
  const pWin = pr.slice(0, P_WINDOW);
  const failures = pWin.filter((o) => o.failed);
  const exonerated = failures.filter((o) => redOnMain(o));
  const f = failures.length - exonerated.length;
  const n = pWin.length;
  const cMin = costWin.length ? median(costWin.map((o) => o.secs)) / 60 : null;
  const p = laplace(f, n);
  return {
    n,
    f,
    rawFailures: failures.length,
    exonerated: exonerated.length,
    p: Number(p.toFixed(4)),
    c_min: cMin === null ? null : Number(cMin.toFixed(2)),
    score: cMin ? Number((p / Math.max(cMin, 1 / 60)).toFixed(4)) : null,
  };
}

async function main() {
  const started = Date.now();
  const runs = [];
  for (const w of WORKFLOWS) runs.push(...(await listRuns(w)));
  const verdictRuns = runs.filter(
    (r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped"
  );
  console.error(
    `check-scores: ${runs.length} completed runs read, ${runs.length - verdictRuns.length} cancelled excluded; reading jobs…`
  );
  await pool(verdictRuns, 8, async (r) => {
    r.jobs = await jobsOf(r);
  });
  verdictRuns.sort((a, b) => Date.parse(b.started) - Date.parse(a.started));

  // Test files: the judge's [new-failure] list of every failed ratchet step.
  const judged = [];
  await pool(verdictRuns, 8, async (r) => {
    const judge = r.jobs.find((j) => j.name === "Full suite");
    const step = judge?.steps.find((s) => s.name.startsWith("Test ratchet"));
    if (
      !step ||
      (step.conclusion !== "success" && step.conclusion !== "failure")
    )
      return;
    let files = [];
    if (step.conclusion === "failure") {
      try {
        files = parseNewFailures(
          await gh(`repos/${REPO}/actions/jobs/${judge.id}/logs`, { raw: true })
        );
      } catch {
        return; // log expired or unreadable: no verdict for this run
      }
    }
    judged.push({ run: r, files: new Set(files) });
  });
  judged.sort((a, b) => Date.parse(b.run.started) - Date.parse(a.run.started));

  const { units, steps } = observe(verdictRuns);
  const mainRuns = verdictRuns.filter(isMain);
  const mainObs = (list) => {
    const m = new Map();
    for (const o of list) if (isMain(o.run)) m.set(`${o.run.id}|${o.key}`, o);
    return m;
  };
  const mainUnits = mainObs(units);
  const mainSteps = mainObs(steps);
  const redOnMainOf = (index) => (o) => {
    const m = mainBefore(o.run, mainRuns);
    return !!m && !!index.get(`${m.id}|${o.key}`)?.failed;
  };

  const group = (list) => {
    const g = new Map();
    for (const o of list) {
      if (!g.has(o.key)) g.set(o.key, []);
      g.get(o.key).push(o);
    }
    return g;
  };
  const sortByScore = (rows) =>
    rows
      .map((r) => ({
        ...r,
        lowSample: r.n < MIN_SAMPLE,
        ...(r.check ? { setup: SETUP_STEP.test(r.check) } : {}),
      }))
      .sort(
        (a, b) =>
          a.lowSample - b.lowSample ||
          (a.setup ?? false) - (b.setup ?? false) ||
          (b.score ?? -1) - (a.score ?? -1) ||
          b.p - a.p
      );

  const unitRows = sortByScore(
    [...group(units)].map(([key, obs]) => ({
      unit: key,
      ...score(obs, redOnMainOf(mainUnits)),
    }))
  ).filter((r) => r.n > 0);
  const stepRows = sortByScore(
    [...group(steps)].map(([key, obs]) => ({
      check: key,
      unit: obs[0].unit,
      ...score(obs, redOnMainOf(mainSteps)),
    }))
  ).filter((r) => r.n > 0);

  // Test files: n = PR runs whose ratchet judged, f = runs where the file was a
  // new failure that main's judge did not also report at the time.
  const prJudged = judged.filter((j) => isPr(j.run)).slice(0, P_WINDOW);
  const mainJudged = judged.filter((j) => isMain(j.run));
  const fileCounts = new Map();
  for (const j of prJudged) {
    const m = mainJudged.find(
      (x) => Date.parse(x.run.started) < Date.parse(j.run.started)
    );
    for (const f of j.files) {
      const c = fileCounts.get(f) ?? { raw: 0, exonerated: 0 };
      c.raw++;
      if (m?.files.has(f)) c.exonerated++;
      fileCounts.set(f, c);
    }
  }
  const testRows = [...fileCounts]
    .map(([file, c]) => ({
      check: `test file ${file}`,
      unit: "Full suite",
      n: prJudged.length,
      f: c.raw - c.exonerated,
      rawFailures: c.raw,
      exonerated: c.exonerated,
      p: Number(laplace(c.raw - c.exonerated, prJudged.length).toFixed(4)),
      c_min: null,
      score: null,
    }))
    .sort((a, b) => b.p - a.p);

  // Time to the first red, today: from the run's start to the first failed step.
  const firstRed = verdictRuns
    .filter((r) => isPr(r) && r.conclusion === "failure")
    .map((r) => {
      const fails = r.jobs
        .flatMap((j) => j.steps)
        .filter(
          (s) =>
            s.conclusion === "failure" && !HOLD_STEP.test(s.name) && s.completed
        );
      if (!fails.length) return null;
      return Math.min(...fails.map((s) => secs(r.started, s.completed))) / 60;
    })
    .filter((x) => x !== null)
    .slice(0, P_WINDOW);

  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  const doc = {
    generatedAt: new Date().toISOString(),
    generatedBy: "node scripts/ci/check-scores.mjs",
    refresh:
      "weekly: rerun the generator and commit this file (prior-art brief rule 4)",
    repo: REPO,
    workflows: WORKFLOWS,
    formula: {
      c: `median wall-clock minutes over the last ${COST_WINDOW} PR runs where the unit ran (setup included, queue excluded)`,
      p: `(f+1)/(n+2) over the last ${P_WINDOW} PR runs with a verdict; f excludes a red main also had at the time; latest attempt only`,
      score: "p/c, descending",
      source: "pod document da67c51b (prior-art brief) §7",
    },
    window: {
      runsRead: runs.length,
      cancelledExcluded: runs.length - verdictRuns.length,
      oldest: verdictRuns.at(-1)?.started ?? null,
      newest: verdictRuns[0]?.started ?? null,
      prRuns: verdictRuns.filter(isPr).length,
      mainRuns: mainRuns.length,
      judgedPrRuns: prJudged.length,
    },
    minutesToFirstRed: {
      runs: firstRed.length,
      median: firstRed.length ? Number(median(firstRed).toFixed(1)) : null,
    },
    units: unitRows,
    checks: [...stepRows, ...testRows],
    // Written by `pnpm preflight --record-costs`; kept across regenerations.
    preflightCosts: prev.preflightCosts ?? {},
  };
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.error(
    `check-scores: wrote ${OUT} (${unitRows.length} units, ${stepRows.length} steps, ${testRows.length} test files) in ${((Date.now() - started) / 1000).toFixed(0)}s`
  );
  const show = (rows, label) => {
    console.log(`\n${label}`);
    console.log("  score    p       f/n     c(min)  check");
    for (const r of rows.slice(0, 15))
      console.log(
        `  ${String(r.score ?? "-").padEnd(8)} ${String(r.p).padEnd(7)} ${`${r.f}/${r.n}`.padEnd(7)} ${String(r.c_min ?? "-").padEnd(7)} ${r.unit ?? ""}${r.check ? ` :: ${r.check}` : ""}`
      );
  };
  show(unitRows, "UNITS (score = p/c)");
  show(stepRows, "STEPS");
  show(testRows, "TEST FILES (new failures in the ratchet judge)");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
