#!/usr/bin/env node
/**
 * cancel-superseded-queue-runs.mjs — cancel the merge-queue CI runs whose
 * queue entry no longer exists, and a main run stalled on a job GitHub never
 * starts while a newer main run waits (STALL_MS, sweepStalledMain).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * ci.yml gives each merge-queue run its own concurrency group (one per
 * commit: every live entry must report), so nothing cancels a run when its
 * entry goes away. Every move of main, and every entry that fails ahead of
 * others, makes the queue rebuild the entries behind it on a new base
 * (`gh-readonly-queue/main/pr-<N>-<base sha>`, a new head commit), and the
 * old entries' runs keep running or waiting. On 2026-10-29, 24 such runs sat
 * in the org's 20-job cap (finding 66c40812; founder, decision ffaafe15).
 *
 * A concurrency group keyed by PR number would do it in ci.yml, but GitHub
 * expressions have no regex or substring function, and the merge_group
 * payload carries no PR number: the number is only inside head_ref. So this
 * sweep runs on every `merge_group` event (each rebuild fires one per new
 * entry) and asks GitHub which entries are live.
 *
 * ── WHAT IT CANCELS ──────────────────────────────────────────────────────────
 * A run is cancelled only when ALL hold (selectSupersededQueueRuns):
 *   - its event is `merge_group` — never `push` (main), never `pull_request`;
 *   - its workflow file is ci.yml (CANCELLABLE_WORKFLOWS);
 *   - it is queued or running;
 *   - its branch is a queue branch of main (`gh-readonly-queue/main/pr-<N>-…`);
 *   - its head commit is NOT the head commit of a live entry of main's merge
 *     queue (GraphQL `mergeQueue(branch: "main") { entries }`), and is not the
 *     commit whose event started this sweep;
 *   - its head commit is not already on main (an entry that just MERGED: its
 *     run's remaining jobs are left to finish; compare main...<sha>);
 *   - it was created at least MIN_AGE_MS (3 min) ago: a run younger than that
 *     may belong to an entry the live list does not show yet (the list and
 *     the runs are two reads, and the queue builds as it moves). A later
 *     sweep (the next merge_group event) catches it if it is a true leftover;
 *   - it is not this workflow's own run.
 *
 * ── FAIL-SAFE ────────────────────────────────────────────────────────────────
 * Cancelling a live entry's run drops that PR from the queue; missing a dead
 * run only wastes runner minutes. So every doubt cancels NOTHING: the live
 * list unreadable (an HTTP error, GraphQL errors, no merge queue, a second
 * page we did not read, a head commit that is not a sha), the live list
 * EMPTY (the entry that started this sweep should be in it), a run list
 * unreadable, a merged-check unreadable (that run is kept), a run with no
 * readable creation time. The runs are listed BEFORE the live entries: a run
 * exists only after its entry, so an entry created between the two reads is
 * still seen live.
 * An entry with NO head commit (`headCommit: null`, nullable in the schema)
 * is one the queue has not built: beyond `maximumEntriesToBuild` (2 here) an
 * entry waits without a merge group. It has no run to protect, so it is
 * skipped, not read as a broken list: distrusting the list for it would
 * cancel nothing exactly when the queue is longest. (Not observed live: the
 * queue held 2 or fewer entries whenever it was read, 2026-10-29.)
 *
 * Usage (.github/workflows/cancel-superseded-queue-runs.yml):
 *   env GITHUB_TOKEN (actions: write, contents: read, pull-requests: read),
 *   GITHUB_REPOSITORY, GITHUB_RUN_ID, TRIGGER_SHA (merge_group.head_sha).
 *   `--dry-run` lists without cancelling.
 * Self-contained (node: builtins + global fetch): no install.
 */
import { pathToFileURL } from "node:url";
import { CANCELLABLE_WORKFLOWS, IN_FLIGHT } from "./cancel-closed-pr-runs.mjs";

/** The branch whose merge queue this sweeps. */
export const QUEUE_BASE = "main";
/** A queue branch of main: `gh-readonly-queue/main/pr-<N>-<base sha>`. */
export const QUEUE_BRANCH = /^gh-readonly-queue\/main\/pr-(\d+)-[0-9a-f]{40}$/;
/** A run younger than this is never cancelled (see WHAT IT CANCELS). */
export const MIN_AGE_MS = 3 * 60_000;
/** The run statuses listed (the API filters one status per call). */
export const LISTED_STATUSES = ["queued", "in_progress", "waiting"];

export const LIVE_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 100) {
        pageInfo { hasNextPage }
        nodes { headCommit { oid } pullRequest { number } }
      }
    }
  }
}`;

const SHA = /^[0-9a-f]{40}$/;

/**
 * The head commits of the live queue entries, from the GraphQL response
 * body, or null when the answer cannot be trusted whole. Pure.
 * @returns {Set<string> | null}
 */
export function liveEntryShas(body) {
  if (!body || body.errors?.length) return null;
  const entries = body.data?.repository?.mergeQueue?.entries;
  if (!entries || !Array.isArray(entries.nodes)) return null;
  if (entries.pageInfo?.hasNextPage !== false) return null;
  const shas = new Set();
  for (const node of entries.nodes) {
    if (!node || typeof node !== "object") return null;
    // Not built yet (beyond maximumEntriesToBuild): no merge group, no run.
    if (node.headCommit === null) continue;
    const oid = node.headCommit?.oid;
    if (typeof oid !== "string" || !SHA.test(oid)) return null;
    shas.add(oid);
  }
  return shas;
}

/**
 * The runs whose queue entry is gone, each with why. Pure.
 * @param {{ runs: Array<Record<string, any>>, live: Set<string> | null,
 *           triggerSha?: string, selfRunId?: number, now?: number }} input
 * @returns {Array<{ id: number, sha: string, url?: string, why: string }>}
 */
export function selectSupersededQueueRuns({
  runs,
  live,
  triggerSha,
  selfRunId,
  now = Date.now(),
}) {
  // No trustworthy live list, or an empty one: cancel nothing.
  if (!(live instanceof Set) || live.size === 0) return [];
  const out = [];
  const seen = new Set();
  for (const run of runs ?? []) {
    if (run.event !== "merge_group") continue;
    if (!CANCELLABLE_WORKFLOWS.includes(run.path)) continue;
    if (!IN_FLIGHT.has(run.status)) continue;
    if (run.id === selfRunId || seen.has(run.id)) continue;
    const pr = QUEUE_BRANCH.exec(run.head_branch ?? "")?.[1];
    if (!pr) continue;
    const sha = String(run.head_sha ?? "");
    if (!SHA.test(sha)) continue;
    if (live.has(sha) || sha === triggerSha) continue;
    const created = Date.parse(run.created_at ?? "");
    if (!Number.isFinite(created) || now - created < MIN_AGE_MS) continue;
    seen.add(run.id);
    out.push({
      id: run.id,
      sha,
      url: run.html_url,
      why: `#${pr}'s queue run ${run.status} on ${sha.slice(0, 9)}: no live entry of the ${QUEUE_BASE} queue has that head`,
    });
  }
  return out;
}

/**
 * One sweep, through `request` (method, path, body) → { ok, status, json() }.
 * Returns what it did; never throws on an API answer.
 */
export async function sweep({
  request,
  repo,
  selfRunId,
  triggerSha,
  dryRun = false,
  log = console.log,
  now = Date.now(),
}) {
  const result = { cancelled: [], kept: [], reason: "" };
  const stop = (reason) => {
    result.reason = reason;
    log(`::warning::${reason}; nothing cancelled`);
    return result;
  };
  const [owner, name] = String(repo ?? "").split("/");
  if (!owner || !name) return stop(`no repository (${repo})`);

  // 1. The in-flight merge-queue runs of ci.yml, FIRST (see FAIL-SAFE).
  const runs = [];
  for (const status of LISTED_STATUSES) {
    const res = await request(
      "GET",
      `/repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&status=${status}&per_page=100`
    );
    if (!res.ok)
      return stop(
        `could not list the ${status} queue runs (HTTP ${res.status})`
      );
    runs.push(...((await res.json()).workflow_runs ?? []));
  }

  // 2. The live entries of main's merge queue.
  const q = await request("POST", "/graphql", {
    query: LIVE_QUERY,
    variables: { owner, name, branch: QUEUE_BASE },
  });
  if (!q.ok)
    return stop(
      `could not read the ${QUEUE_BASE} merge queue (HTTP ${q.status})`
    );
  const live = liveEntryShas(await q.json());
  if (!live)
    return stop(`the ${QUEUE_BASE} merge queue answer cannot be trusted whole`);
  if (live.size === 0)
    return stop(
      `the ${QUEUE_BASE} merge queue reads empty while an entry started this sweep`
    );

  const picks = selectSupersededQueueRuns({
    runs,
    live,
    triggerSha,
    selfRunId,
    now,
  });
  log(
    `${QUEUE_BASE} queue: ${live.size} live entr${live.size === 1 ? "y" : "ies"}, ${runs.length} in-flight queue run(s), ${picks.length} superseded`
  );

  for (const r of picks) {
    // 3. An entry that just merged is not superseded: its sha is on main.
    const cmp = await request(
      "GET",
      `/repos/${repo}/compare/${QUEUE_BASE}...${r.sha}`
    );
    if (!cmp.ok) {
      log(
        `::warning::kept ${r.id}: could not compare ${r.sha.slice(0, 9)} with ${QUEUE_BASE} (HTTP ${cmp.status})`
      );
      result.kept.push(r.id);
      continue;
    }
    // Only a commit NOT on main is superseded ("ahead" of main, or
    // "diverged" from it: built on an older main). "behind" or "identical"
    // is an entry that just merged; anything else is kept too.
    const status = (await cmp.json()).status;
    if (status !== "ahead" && status !== "diverged") {
      log(
        `  kept ${r.id}: ${r.sha.slice(0, 9)} is ${status === "behind" || status === "identical" ? `on ${QUEUE_BASE} (merged)` : `"${status}" against ${QUEUE_BASE}`}`
      );
      result.kept.push(r.id);
      continue;
    }
    if (dryRun) {
      log(`  would cancel ${r.id}: ${r.why}`);
      continue;
    }
    const res = await request(
      "POST",
      `/repos/${repo}/actions/runs/${r.id}/cancel`
    );
    // 409: the run finished between the list and the cancel.
    if (res.ok || res.status === 409) {
      log(`  cancelled ${r.id}: ${r.why} (${r.url ?? ""})`);
      result.cancelled.push(r.id);
    } else {
      log(`::warning::could not cancel ${r.id} (HTTP ${res.status}): ${r.why}`);
      result.kept.push(r.id);
    }
  }
  return result;
}

/**
 * A main push run whose job GitHub never starts holds main's concurrency
 * group (ci.yml: one main run at a time, a newer one waits `pending` and
 * replaces the previous pending one). Nothing else ends it: GitHub drops a
 * queued job only after 24 h. 29 Oct 2026: the "Full suite" judge of run
 * 40909558682 (main 888162ba) sat queued from 16:53 to 18:44 while every
 * other job ran, and 13 newer main runs waited and were replaced; main had
 * no finished post-merge run from 16:05 on, so no culprit could be named
 * and the nightly had no newer green commit.
 *
 * A run is cancelled only when ALL hold (selectStalledMainRuns): it is a
 * ci.yml `push` run on main, in flight; a NEWER ci.yml push run on main is
 * waiting for the group (`pending`); and one of its jobs has been `queued`
 * for STALL_MS or more. The newer run tests a main that contains this
 * run's commit, so nothing is lost. Every doubt keeps it: an unreadable run
 * or job list, a job with no readable creation time.
 */
export const STALL_MS = 30 * 60_000;

/** The stalled main runs to cancel, each with why. Pure. */
export function selectStalledMainRuns({ runs, jobsByRun, now = Date.now() }) {
  const main = (runs ?? []).filter(
    (r) =>
      r.event === "push" &&
      r.head_branch === QUEUE_BASE &&
      CANCELLABLE_WORKFLOWS.includes(r.path) &&
      IN_FLIGHT.has(r.status)
  );
  const out = [];
  for (const run of main) {
    const created = Date.parse(run.created_at ?? "");
    if (!Number.isFinite(created)) continue;
    const newerWaits = main.some(
      (o) =>
        o.id !== run.id &&
        o.status === "pending" &&
        Date.parse(o.created_at ?? "") > created
    );
    if (!newerWaits) continue;
    const jobs = jobsByRun?.get(run.id);
    if (!Array.isArray(jobs)) continue;
    const stuck = jobs.find((j) => {
      const at = Date.parse(j?.created_at ?? "");
      return (
        j?.status === "queued" && Number.isFinite(at) && now - at >= STALL_MS
      );
    });
    if (!stuck) continue;
    out.push({
      id: run.id,
      sha: String(run.head_sha ?? ""),
      url: run.html_url,
      why: `main run ${run.id} (${String(run.head_sha ?? "").slice(0, 9)}): job "${stuck.name}" queued for ${Math.round((now - Date.parse(stuck.created_at)) / 60_000)} min while a newer main run waits for the group`,
    });
  }
  return out;
}

/** One stalled-main sweep, through the same `request` as sweep(). */
export async function sweepStalledMain({
  request,
  repo,
  dryRun = false,
  log = console.log,
  now = Date.now(),
}) {
  const result = { cancelled: [], kept: [] };
  const runs = [];
  for (const status of LISTED_STATUSES.concat("pending")) {
    const res = await request(
      "GET",
      `/repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=${QUEUE_BASE}&status=${status}&per_page=100`
    );
    if (!res.ok) {
      log(
        `::warning::could not list the ${status} main runs (HTTP ${res.status}); no main run cancelled`
      );
      return result;
    }
    runs.push(...((await res.json()).workflow_runs ?? []));
  }
  const jobsByRun = new Map();
  for (const r of runs) {
    if (r.status === "pending") continue;
    const res = await request(
      "GET",
      `/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`
    );
    if (res.ok) jobsByRun.set(r.id, (await res.json()).jobs ?? []);
  }
  for (const r of selectStalledMainRuns({ runs, jobsByRun, now })) {
    if (dryRun) {
      log(`  would cancel ${r.id}: ${r.why}`);
      continue;
    }
    const res = await request(
      "POST",
      `/repos/${repo}/actions/runs/${r.id}/cancel`
    );
    if (res.ok || res.status === 409) {
      log(`  cancelled ${r.id}: ${r.why} (${r.url ?? ""})`);
      result.cancelled.push(r.id);
    } else {
      log(`::warning::could not cancel ${r.id} (HTTP ${res.status}): ${r.why}`);
      result.kept.push(r.id);
    }
  }
  return result;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("::warning::no GITHUB_TOKEN; nothing cancelled");
    return;
  }
  const request = (method, path, body) =>
    fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => ({
      ok: false,
      status: `network: ${err.message}`,
      json: async () => ({}),
    }));
  await sweep({
    request,
    repo: process.env.GITHUB_REPOSITORY,
    selfRunId: Number(process.env.GITHUB_RUN_ID),
    triggerSha: process.env.TRIGGER_SHA,
    dryRun: process.argv.includes("--dry-run"),
  });
  await sweepStalledMain({
    request,
    repo: process.env.GITHUB_REPOSITORY,
    dryRun: process.argv.includes("--dry-run"),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
