#!/usr/bin/env node
/**
 * release-gate-wait.mjs — may a pod get this commit?
 *
 *   release-gate-wait.mjs <owner/repo> <sha>             wait, then exit 0|1
 *   release-gate-wait.mjs --once <owner/repo> <sha>      one read: exit 0 pass,
 *                                                        1 fail, 3 still running,
 *                                                        2 a GitHub read failed
 *   release-gate-wait.mjs --culprits <owner/repo> <sha>  red main: name the
 *                                                        commits since the last
 *                                                        all-green main commit
 *
 * ── THE RULE (founder, 2026-10-29, "One trunk, three CI tiers") ─────────────
 * A pull request runs only the tests of what it can break; main runs
 * everything after the merge. So a pod updates only to a main commit whose
 * POST-MERGE run was ALL green: one CI run of that commit triggered by the
 * push (`event=push`, main or a release/** branch) on which every required
 * check ("Release gate", "Full suite", "API e2e", "Reference docs are
 * current"; scripts/apply-main-protection.sh REQUIRED_CHECKS, pinned equal by
 * the tripwire) concluded `success` on its latest attempt. Until 2026-10-29
 * this read the "Release gate" alone ("Full suite red is a backlog, not a
 * release blocker").
 *
 * The merge queue's run has the SAME commit sha (main fast-forwards to the
 * queue's commit), and its checks may have passed by reuse or a "Not
 * affected" step; only the push run's own check suite counts, so a queue
 * verdict never stands in for the post-merge run.
 *
 *   pass  some push run of the commit has all 4 required checks `success`.
 *   wait  a push run is queued or running and none of its required checks has
 *         ended without success yet.
 *   fail  no push run at all (a commit superseded before its run started, or
 *         never on main), or every push run ended with a required check not
 *         `success` (failure, cancelled, skipped, neutral, timed_out...).
 *
 * Doors that read it (.github/workflows/docker-publish.yml): the v* tag
 * (stable) and "Run workflow" (fast) WAIT on the exact commit; the nightly
 * fast release PICKS the newest first-parent main commit that passes
 * (deploy/release/nightly-fast-pick.sh, `--once`). ci.yml's "Red main" job
 * names the culprit range (`--culprits`).
 *
 * Polls every RELEASE_GATE_POLL_SECONDS (default 60) for at most
 * RELEASE_GATE_TIMEOUT_MINUTES (default 90: a post-merge run is the full
 * suite, ~20-30 min plus its queue wait). Reads GitHub only, through `gh api`
 * (GH_TOKEN). A failed read is a failure, never taken for "no run".
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The ruleset's required checks; all must pass on one post-merge run. */
export const REQUIRED_CHECKS = [
  "Release gate",
  "Full suite",
  "API e2e",
  "Reference docs are current",
];
export const CI_WORKFLOW = "ci.yml";

/** Statuses of a check run or a workflow run that has not finished yet. */
const IN_FLIGHT = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
]);

/**
 * One push run's state: "green" | "pending" | "red", and a line per check.
 * `run` = { status, html_url, checks: [{ name, status, conclusion }] } where
 * checks are the LATEST attempt of each check run of the run's check suite.
 */
export function runState(run) {
  const lines = [];
  let red = false;
  let pending = false;
  for (const name of REQUIRED_CHECKS) {
    const c = (run.checks ?? []).find((x) => x.name === name);
    if (!c) {
      if (IN_FLIGHT.has(run.status)) pending = true;
      else red = true;
      lines.push(`${name}: not run`);
    } else if (c.conclusion === "success") {
      lines.push(`${name}: success`);
    } else if (IN_FLIGHT.has(c.status)) {
      pending = true;
      lines.push(`${name}: ${c.status}`);
    } else {
      red = true;
      lines.push(`${name}: ${c.conclusion ?? c.status}`);
    }
  }
  return { state: red ? "red" : pending ? "pending" : "green", lines };
}

/**
 * The verdict for one read of the commit.
 * @param {{ pushRuns: Array<{status: string, html_url?: string, checks: Array<{name: string, status: string, conclusion: string|null}>}> }} read
 * @returns {{ verdict: "pass"|"wait"|"fail", reason: string }}
 */
export function decide({ pushRuns }) {
  if (!pushRuns?.length)
    return {
      verdict: "fail",
      reason:
        "No post-merge CI run (event push) of this commit. Only a main commit whose push run went all green can reach a pod.",
    };
  const states = pushRuns.map((r) => ({ r, ...runState(r) }));
  const green = states.find((s) => s.state === "green");
  if (green)
    return {
      verdict: "pass",
      reason: `the post-merge run is all green (${green.r.html_url ?? "run"}): ${green.lines.join(", ")}`,
    };
  const pending = states.find((s) => s.state === "pending");
  if (pending)
    return {
      verdict: "wait",
      reason: `the post-merge run is ${pending.r.status} (${pending.r.html_url ?? "run"}): ${pending.lines.join(", ")}`,
    };
  const last = states[0];
  return {
    verdict: "fail",
    reason: `the post-merge run is not all green (run ${last.r.conclusion ?? last.r.status}, ${last.r.html_url ?? "run"}): ${last.lines.join(", ")}. Only a success on all ${REQUIRED_CHECKS.length} required checks counts; fix main and release a commit whose post-merge run is green.`,
  };
}

/**
 * Poll until a verdict other than "wait", or until the time runs out.
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
export async function waitForReleaseGate({
  read,
  sleep,
  now,
  intervalMs,
  timeoutMs,
  log = () => {},
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let d;
    try {
      d = decide(read());
    } catch (err) {
      return {
        ok: false,
        reason: `GitHub read failed, so the post-merge run is unknown (not taken as absent): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (d.verdict === "pass") return { ok: true, reason: d.reason };
    if (d.verdict === "fail") return { ok: false, reason: d.reason };
    if (now() + intervalMs > deadline) {
      return {
        ok: false,
        reason: `Waited ${Math.round(timeoutMs / 60000)} min and the post-merge run has not finished: ${d.reason} Release again once it is green.`,
      };
    }
    log(`waiting: ${d.reason}`);
    await sleep(intervalMs);
  }
}

/** One `gh api` read, parsed. Throws on any gh error (auth, network, 404). */
function ghJson(path) {
  const out = execFileSync("gh", ["api", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

/** The push runs of a commit, each with the latest check runs of its suite. */
export function githubReader(repo, sha) {
  return () => ({
    pushRuns: ghJson(
      `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&event=push&per_page=100`
    ).workflow_runs.map((r) => ({
      status: r.status,
      conclusion: r.conclusion,
      html_url: r.html_url,
      checks: ghJson(
        `repos/${repo}/check-suites/${r.check_suite_id}/check-runs?filter=latest&per_page=100`
      ).check_runs.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
      })),
    })),
  });
}

/**
 * The red-main culprit range: walk `commits` (newest first, the first-parent
 * line BEFORE the red commit) until one passes. `verdictOf(sha)` is one read.
 * Returns { lastGreen: sha|null, suspects: [sha] } — suspects are the red
 * commit's predecessors that are not all green, newest first.
 */
export function culpritRange(commits, verdictOf) {
  const suspects = [];
  for (const sha of commits) {
    if (verdictOf(sha).verdict === "pass") return { lastGreen: sha, suspects };
    suspects.push(sha);
  }
  return { lastGreen: null, suspects };
}

function usage() {
  console.error(
    "usage: release-gate-wait.mjs [--once | --culprits] <owner/repo> <40-hex sha>"
  );
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0]?.startsWith("--") ? args.shift() : "--wait";
  const [repo, sha] = args;
  if (!repo || !/^[0-9a-f]{40}$/.test(sha ?? "")) usage();

  if (mode === "--once") {
    let d;
    try {
      d = decide(githubReader(repo, sha)());
    } catch (err) {
      console.error(`::error::GitHub read failed: ${err.message}`);
      process.exit(2);
    }
    console.error(`${sha.slice(0, 7)}: ${d.verdict}: ${d.reason}`);
    process.exit(d.verdict === "pass" ? 0 : d.verdict === "wait" ? 3 : 1);
  }

  if (mode === "--culprits") {
    const limit = Number(process.env.CULPRIT_LIMIT || 30);
    // The red commit, then its first-parent line (a checkout with history).
    const line = execFileSync(
      "git",
      [
        "log",
        "--first-parent",
        "--format=%H%x09%h %an: %s",
        `-n${limit + 1}`,
        sha,
      ],
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));
    const subject = new Map(line);
    // A failed read is a suspect, never a green.
    const r = culpritRange(
      line.slice(1).map(([h]) => h),
      (c) => {
        try {
          return decide(githubReader(repo, c)());
        } catch {
          return { verdict: "fail" };
        }
      }
    );
    const own = subject.get(sha) ?? sha.slice(0, 9);
    const lines = [
      "### Red main: the commits since the last all-green main",
      "",
      r.lastGreen
        ? `Last main commit whose post-merge run was all green: \`${r.lastGreen.slice(0, 9)}\`. The red is in \`${r.lastGreen.slice(0, 9)}..${sha.slice(0, 9)}\`:`
        : `No all-green main commit in the last ${limit}. Every commit below is a suspect:`,
      "",
      `- \`${own}\` (this run)`,
      ...r.suspects.map(
        (c) =>
          `- \`${subject.get(c) ?? c.slice(0, 9)}\` (its own post-merge run is not all green, or still running)`
      ),
      "",
      "One owner per red main (.claude/rules/github-ci.md): look for an open `main red: backend` session before writing a fix.",
      "",
    ];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
    return;
  }

  if (mode !== "--wait") usage();
  const intervalMs = Number(process.env.RELEASE_GATE_POLL_SECONDS || 60) * 1000;
  const timeoutMs =
    Number(process.env.RELEASE_GATE_TIMEOUT_MINUTES || 90) * 60 * 1000;
  const r = await waitForReleaseGate({
    read: githubReader(repo, sha),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    intervalMs,
    timeoutMs,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  if (r.ok) {
    console.log(`Post-merge run all green on ${sha}: ${r.reason}`);
    return;
  }
  console.log(`::error::${r.reason}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
