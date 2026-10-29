#!/usr/bin/env node
/**
 * cancel-closed-pr-runs.mjs — when a pull request closes (merged or not),
 * cancel the CI runs it still has queued or running.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * 2026-10-28 22:20Z: ~50 backend runs were queued, and 11 were CI for PRs
 * that had already merged. The org has 20 concurrent jobs and one CI run takes
 * ~8: a merged PR's run holds slots every open PR waits behind, to judge a
 * branch nobody will merge again. (The merge queue tested the merged result
 * on its own run; main's push run measures it after.)
 *
 * ── WHAT IT CANCELS ──────────────────────────────────────────────────────────
 * A run is cancelled only when ALL hold (selectRunsToCancel):
 *   - its event is `pull_request` — never `push` (main, develop, release/**)
 *     and never `merge_group` (the merge queue);
 *   - its workflow file is one of CANCELLABLE_WORKFLOWS (ci.yml): never "Pod
 *     observations", which posts the very `dev.pr_merged` this close fires;
 *   - it is queued or running;
 *   - its head branch is the PR's head branch, from the PR's head repository,
 *     and is not a protected or queue branch (main, develop, release/*,
 *     gh-readonly-queue/*);
 *   - it belongs to THIS PR: its `pull_requests` names only this PR, or it
 *     names none and the run is of the PR's head commit. A run another open
 *     PR shares (two PRs from one branch) is left alone;
 *   - it is not this workflow's own run.
 *
 * Usage (.github/workflows/cancel-closed-pr-runs.yml):
 *   env GITHUB_TOKEN (actions: write), GITHUB_REPOSITORY, GITHUB_EVENT_PATH,
 *   GITHUB_RUN_ID. `--dry-run` lists without cancelling.
 * Self-contained (node: builtins + global fetch): no install.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CANCELLABLE_WORKFLOWS = [".github/workflows/ci.yml"];

export const IN_FLIGHT = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);

/** Branches whose runs are never a PR's to cancel. */
export const PROTECTED_BRANCH =
  /^(main|develop|release\/.*|gh-readonly-queue\/.*)$/;

/**
 * The runs to cancel for one closed PR, each with why. Pure.
 * @param {{ pr: { number: number, headRef: string, headSha: string, headRepo: string },
 *           runs: Array<Record<string, any>>, selfRunId?: number }} input
 * @returns {Array<{ id: number, url?: string, why: string }>}
 */
export function selectRunsToCancel({ pr, runs, selfRunId }) {
  if (!pr?.number || !pr.headRef || PROTECTED_BRANCH.test(pr.headRef))
    return [];
  const out = [];
  for (const run of runs ?? []) {
    if (run.event !== "pull_request") continue;
    if (!CANCELLABLE_WORKFLOWS.includes(run.path)) continue;
    if (!IN_FLIGHT.has(run.status)) continue;
    if (run.id === selfRunId) continue;
    if (run.head_branch !== pr.headRef) continue;
    if (PROTECTED_BRANCH.test(run.head_branch ?? "")) continue;
    if (run.head_repository?.full_name !== pr.headRepo) continue;
    const numbers = (run.pull_requests ?? []).map((p) => p?.number);
    const ours = numbers.length
      ? numbers.every((n) => n === pr.number)
      : run.head_sha === pr.headSha;
    if (!ours) continue;
    out.push({
      id: run.id,
      url: run.html_url,
      why: `${run.name ?? run.path} ${run.status} on ${run.head_branch}@${String(run.head_sha).slice(0, 9)}`,
    });
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const p = event.pull_request;
  if (!repo || !token || !p) {
    console.log("not a pull_request event with a token: nothing to do");
    return;
  }
  const pr = {
    number: p.number,
    headRef: p.head?.ref,
    headSha: p.head?.sha,
    headRepo: p.head?.repo?.full_name,
  };
  const api = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    return res;
  };
  const list = await api(
    `/actions/runs?branch=${encodeURIComponent(pr.headRef)}&event=pull_request&per_page=100`
  );
  if (!list.ok) {
    // A read we could not make cancels nothing; said, not swallowed.
    console.log(
      `::warning::could not list the runs of ${pr.headRef} (HTTP ${list.status}); nothing cancelled`
    );
    return;
  }
  const runs = (await list.json()).workflow_runs ?? [];
  const picks = selectRunsToCancel({
    pr,
    runs,
    selfRunId: Number(process.env.GITHUB_RUN_ID),
  });
  console.log(
    `#${pr.number} closed (${p.merged ? "merged" : "not merged"}): ${runs.length} run(s) on ${pr.headRef}, ${picks.length} to cancel`
  );
  let failed = 0;
  for (const r of picks) {
    if (dryRun) {
      console.log(`  would cancel ${r.id}: ${r.why}`);
      continue;
    }
    const res = await api(`/actions/runs/${r.id}/cancel`, { method: "POST" });
    // 409: the run finished between the list and the cancel.
    if (res.ok || res.status === 409)
      console.log(`  cancelled ${r.id}: ${r.why} (${r.url ?? ""})`);
    else {
      failed++;
      console.log(
        `::warning::could not cancel ${r.id} (HTTP ${res.status}): ${r.why}`
      );
    }
  }
  if (failed)
    console.log(`${failed} run(s) could not be cancelled (see warnings)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
