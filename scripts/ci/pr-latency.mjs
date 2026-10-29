#!/usr/bin/env node
/**
 * pr-latency.mjs — how long a backend PR waits for its 4 required checks, from
 * the push to the last of them green, measured from GitHub's own records
 * (read-only: `gh api`). Lane L8, 2026-10-29: the founder's target is 8-10
 * minutes for a typical change.
 *
 * ── WHAT IT MEASURES ─────────────────────────────────────────────────────────
 * For every completed ci.yml `pull_request` run of the last N days whose 4
 * required checks ("Release gate", "Full suite", "API e2e", "Reference docs
 * are current": scripts/apply-main-protection.sh REQUIRED_CHECKS) all
 * concluded `success`:
 *   green        the run's creation (the push) → the last required check's
 *                completion, in minutes; median and p90
 *   per job      each job's queue wait (created → started) and run time
 *                (started → completed), median, and how often it was the
 *                LAST job to finish among the required checks and the jobs
 *                they wait on (the critical path)
 *   tier         what "What changed" decided (its log line `scope=`): full,
 *                selected, affected (before lane L8), none; and the shard
 *                count ("Full suite (shard k/N)")
 * A run with a red or cancelled required check measures nothing about the
 * time to green and is counted apart (`not green`).
 *
 * ── REFRESH ──────────────────────────────────────────────────────────────────
 * Weekly, with scripts/ci/check-scores.json and scripts/ci/shard-plan.json:
 *   node scripts/ci/pr-latency.mjs --days=7
 * and quote the table in the PR or pod document that changes the CI.
 *
 * Usage:
 *   node scripts/ci/pr-latency.mjs [--days=2] [--repo=Synap-core/backend]
 *                                  [--json=out.json] [--limit=400]
 * Needs `gh` logged in with read access to the repo's Actions.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name, dflt) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;

const REPO = flag("repo", "Synap-core/backend");
const DAYS = Number(flag("days", "2"));
const LIMIT = Number(flag("limit", "400"));
const JSON_OUT = flag("json", null);

export const REQUIRED = [
  "Release gate",
  "Full suite",
  "API e2e",
  "Reference docs are current",
];

export const median = (xs) => quantile(xs, 0.5);
export function quantile(xs, q) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}
/** "Full suite (shard 2/8)" → "Full suite (shard k/8)": one row per job kind. */
export const jobKind = (name) =>
  name.replace(/\(shard \d+\/(\d+)\)/, "(shard k/$1)");
const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
const round = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** The tier a "What changed" log names (`scope=full`), or "unknown". */
export function scopeOf(log) {
  return (
    /(?:^|\s)scope=(full|selected|affected|none)\b/m.exec(log ?? "")?.[1] ??
    "unknown"
  );
}

/** The shard count of a run from its job names ("Full suite (shard 2/8)"). */
export function shardCount(jobs) {
  const n = jobs
    .map((j) => /^Full suite \(shard \d+\/(\d+)\)$/.exec(j.name)?.[1])
    .filter(Boolean)
    .map(Number);
  return n.length ? Math.max(...n) : 0;
}

/**
 * Why a run has no time to green: the first required check that did not
 * conclude `success` ("Full suite: failure", "API e2e: missing"), or the run's
 * own conclusion when it was cancelled. Null for a green run.
 */
export function notGreenReason(runRow, jobs) {
  for (const n of REQUIRED) {
    const j = jobs.find((x) => x.name === n);
    if (!j)
      return `${n}: missing${runRow.conclusion === "cancelled" ? " (run cancelled)" : ""}`;
    if (j.conclusion !== "success")
      return `${n}: ${j.conclusion ?? "unfinished"}`;
  }
  return null;
}

/**
 * One run's measurement, or null when it is not green: { green (min), last
 * (the job that finished last), jobs: [{ name, wait, took }] }. Pure.
 */
export function measure(runRow, jobs) {
  const req = REQUIRED.map((n) => jobs.find((j) => j.name === n));
  if (req.some((j) => !j || j.conclusion !== "success" || !j.completed_at))
    return null;
  const ends = jobs.filter((j) => j.completed_at && j.conclusion !== "skipped");
  const lastReq = req.reduce((a, b) =>
    Date.parse(a.completed_at) >= Date.parse(b.completed_at) ? a : b
  );
  // The critical job: the latest-finishing job that ends before the last
  // required check (a judge waits on its shards; the shard is the cause).
  const cut = Date.parse(lastReq.completed_at);
  const crit = ends
    .filter(
      (j) => Date.parse(j.completed_at) <= cut && !REQUIRED.includes(j.name)
    )
    .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0];
  return {
    green: minutes(runRow.created_at, lastReq.completed_at),
    last: jobKind(
      crit && minutes(crit.completed_at, lastReq.completed_at) < 2
        ? crit.name
        : lastReq.name
    ),
    jobs: ends.map((j) => ({
      name: jobKind(j.name),
      wait: j.started_at ? minutes(runRow.created_at, j.started_at) : null,
      took: j.started_at ? minutes(j.started_at, j.completed_at) : null,
    })),
  };
}

// A transient API error (an HTTP/2 stream reset, a 502) is retried twice.
async function gh(path, attempt = 1) {
  try {
    const { stdout } = await run("gh", ["api", path], { maxBuffer: 64 << 20 });
    return stdout;
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return gh(path, attempt + 1);
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]).catch((e) => ({
          error: String(e.message ?? e),
        }));
      }
    })
  );
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  const runs = [];
  for (let page = 1; runs.length < LIMIT && page <= 10; page++) {
    const body = JSON.parse(
      await gh(
        `repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&created=%3E%3D${since}&per_page=100&page=${page}`
      )
    );
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) break;
  }
  const rows = await pool(runs.slice(0, LIMIT), 8, async (r) => {
    const jobs = JSON.parse(
      await gh(`repos/${REPO}/actions/runs/${r.id}/jobs?per_page=100`)
    ).jobs;
    const m = measure(r, jobs);
    let scope = "unknown";
    const changes = jobs.find((j) => j.name === "What changed");
    if (m && changes)
      scope = scopeOf(
        await gh(`repos/${REPO}/actions/jobs/${changes.id}/logs`).catch(
          () => ""
        )
      );
    return {
      run: r.id,
      pr: r.pull_requests?.[0]?.number ?? null,
      created: r.created_at,
      scope,
      shards: shardCount(jobs),
      ...(m ?? { green: null, why: notGreenReason(r, jobs) }),
    };
  });
  const ok = rows.filter((r) => r && !r.error && r.green != null);
  const notGreen = rows.length - ok.length;
  const byScope = {};
  for (const r of ok) (byScope[r.scope] ??= []).push(r);
  const lines = [
    `## PR time to green, ${REPO}, ${since} → now (scripts/ci/pr-latency.mjs)`,
    "",
    `${rows.length} completed PR runs; ${ok.length} with all ${REQUIRED.length} required checks green, ${notGreen} not green (red, cancelled or held).`,
    "",
    `Not green, by the first required check that was not: ${Object.entries(
      rows
        .filter((r) => r?.why)
        .reduce((m, r) => ((m[r.why] = (m[r.why] ?? 0) + 1), m), {})
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, n]) => `${k} ×${n}`)
      .join("; ")}.`,
    "",
    "| tier | runs | push → 4 required green, median | p90 | shards (median) |",
    "|---|---|---|---|---|",
    ...[["all", ok], ...Object.entries(byScope)].map(
      ([k, rs]) =>
        `| ${k} | ${rs.length} | ${round(median(rs.map((r) => r.green)))} min | ${round(
          quantile(
            rs.map((r) => r.green),
            0.9
          )
        )} min | ${median(rs.map((r) => r.shards)) ?? "-"} |`
    ),
    "",
    "| job | runs | queue wait, median | run time, median | last before green |",
    "|---|---|---|---|---|",
  ];
  const jobsBy = {};
  for (const r of ok) for (const j of r.jobs) (jobsBy[j.name] ??= []).push(j);
  const lastCount = {};
  for (const r of ok) lastCount[r.last] = (lastCount[r.last] ?? 0) + 1;
  for (const [name, js] of Object.entries(jobsBy).sort(
    (a, b) =>
      (median(b[1].map((j) => j.took)) ?? 0) -
      (median(a[1].map((j) => j.took)) ?? 0)
  ))
    lines.push(
      `| ${name} | ${js.length} | ${round(median(js.map((j) => j.wait)))} min | ${round(median(js.map((j) => j.took)))} min | ${lastCount[name] ?? 0} |`
    );
  console.log(lines.join("\n"));
  if (JSON_OUT)
    writeFileSync(
      JSON_OUT,
      `${JSON.stringify({ since, repo: REPO, rows }, null, 1)}\n`
    );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
