#!/usr/bin/env node
/**
 * release-gate-wait.mjs <owner/repo> <sha>
 *
 * The `ci-gate` job of docker-publish.yml: a release (v* tag, or "Run
 * workflow" on main) is built only from a commit whose CI "Release gate"
 * check run SUCCEEDED. A release started while that gate is still queued or
 * running WAITS for it here, instead of failing and being re-run by hand
 * (runs 40760093657 and 40704054177 of 2026-10-28 failed 30 s after a merge,
 * with the gate running; it went green 27 min later).
 *
 *   pass  — a "Release gate" check run on the commit succeeded.
 *   wait  — a "Release gate" check run is queued or running, or a CI run of
 *           the commit is queued or running and has not created its "Release
 *           gate" yet (the gate `needs: changes`, so it appears ~15 s after
 *           CI starts, later when runners are scarce).
 *   fail  — no "Release gate" and no CI run at all (a commit that never ran
 *           CI never releases), or every gate ended without success:
 *           failure, cancelled, skipped, neutral, timed_out... are NOT a pass.
 *
 * Polls every RELEASE_GATE_POLL_SECONDS (default 60) for at most
 * RELEASE_GATE_TIMEOUT_MINUTES (default 45, the merge queue's check timeout),
 * then fails. Reads GitHub only, through `gh api` (GH_TOKEN). A failed read is
 * a failure of this step, never taken for "no gate".
 * Exit 0 = pass, 1 = fail.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const GATE_NAME = "Release gate";
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
 * The verdict for one read of the commit.
 * @param {{ gateRuns: Array<{status: string, conclusion: string|null, check_suite?: {id: number}, html_url?: string}>,
 *           ciRuns: Array<{status: string, check_suite_id?: number, html_url?: string}> }} read
 * @returns {{ verdict: "pass"|"wait"|"fail", reason: string }}
 */
export function decide({ gateRuns, ciRuns }) {
  const passed = gateRuns.find((r) => r.conclusion === "success");
  if (passed) {
    return {
      verdict: "pass",
      reason: `"${GATE_NAME}" passed (${passed.html_url ?? "check run"}).`,
    };
  }

  const running = gateRuns.find((r) => IN_FLIGHT.has(r.status));
  if (running) {
    return {
      verdict: "wait",
      reason: `"${GATE_NAME}" is ${running.status} (${running.html_url ?? "check run"}).`,
    };
  }

  // A CI run still in flight whose check suite holds no gate yet: the gate
  // job has not been created (it waits on `changes`, or on a runner).
  const gateSuites = new Set(gateRuns.map((r) => r.check_suite?.id));
  const starting = ciRuns.find(
    (r) => IN_FLIGHT.has(r.status) && !gateSuites.has(r.check_suite_id)
  );
  if (starting) {
    return {
      verdict: "wait",
      reason: `CI is ${starting.status} on this commit and has not started its "${GATE_NAME}" yet (${starting.html_url ?? "workflow run"}).`,
    };
  }

  if (gateRuns.length === 0) {
    return {
      verdict: "fail",
      reason: `No "${GATE_NAME}" ran on this commit, and no CI run is in progress for it. Push it to main (CI runs on every push) and release once its "${GATE_NAME}" is green.`,
    };
  }

  const ended = [...new Set(gateRuns.map((r) => r.conclusion ?? r.status))];
  return {
    verdict: "fail",
    reason: `"${GATE_NAME}" did not pass on this commit (it ended: ${ended.join(", ")}). Only a success counts; fix main and release a commit whose gate is green.`,
  };
}

/**
 * Poll until a verdict other than "wait", or until the time runs out.
 * @param {{ read: () => {gateRuns: any[], ciRuns: any[]},
 *           sleep: (ms: number) => Promise<void>, now: () => number,
 *           intervalMs: number, timeoutMs: number,
 *           log?: (line: string) => void }} io
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
        reason: `GitHub read failed, so the gate is unknown (not taken as absent): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (d.verdict === "pass") return { ok: true, reason: d.reason };
    if (d.verdict === "fail") return { ok: false, reason: d.reason };
    if (now() + intervalMs > deadline) {
      return {
        ok: false,
        reason: `Waited ${Math.round(timeoutMs / 60000)} min and the gate has not finished: ${d.reason} Release again once it is green.`,
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

export function githubReader(repo, sha) {
  const gate = encodeURIComponent(GATE_NAME);
  return () => ({
    gateRuns: ghJson(
      `repos/${repo}/commits/${sha}/check-runs?check_name=${gate}&per_page=100`
    ).check_runs,
    ciRuns: ghJson(
      `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&per_page=100`
    ).workflow_runs,
  });
}

async function main() {
  const [repo, sha] = process.argv.slice(2);
  if (!repo || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
    console.error("usage: release-gate-wait.mjs <owner/repo> <40-hex sha>");
    process.exit(1);
  }
  const intervalMs = Number(process.env.RELEASE_GATE_POLL_SECONDS || 60) * 1000;
  const timeoutMs =
    Number(process.env.RELEASE_GATE_TIMEOUT_MINUTES || 45) * 60 * 1000;
  const r = await waitForReleaseGate({
    read: githubReader(repo, sha),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    intervalMs,
    timeoutMs,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  if (r.ok) {
    console.log(`Release gate passed on ${sha}: ${r.reason}`);
    return;
  }
  console.log(`::error::${r.reason}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
