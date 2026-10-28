#!/usr/bin/env node
/**
 * hold.mjs — the "Dependencies merged" check (R8 option C2b, wave e902fc95).
 * ========================================================================
 *
 * A pull request whose body carries `Depends-On:` lines (grammar: layout.mjs)
 * gets a check run named "Dependencies merged" on its head commit:
 *   - success      no Depends-On line, or every dependency has landed;
 *   - in progress  a dependency has not landed yet (the summary names it);
 *   - failure      a line that does not parse, or a dependency that can never
 *                  land as written (closed unmerged, missing, merged elsewhere).
 * Made a required check of ruleset 25542891, it HOLDS a PR — `--auto` or in the
 * merge queue — until what it depends on is on main, so every PR of a
 * cross-repo change can be enqueued at once and they land in order, with no
 * merge-order list from a person.
 *
 * Run by .github/workflows/depends-on.yml, on:
 *   pull_request_target  the PR itself (opened, edited, synchronize, …);
 *   merge_group          the queue's commit, judged by its PR's lines;
 *   push / schedule / workflow_dispatch
 *                        a SWEEP of every open PR: a held PR is released the
 *                        moment its dependency lands, and an open PR that has
 *                        no check yet gets one (a required check that never
 *                        reports would hold it forever).
 * Each state change posts a NEW check run: the latest run of a name is the one
 * a required check reads. An unchanged state posts nothing.
 *
 * Env: GITHUB_TOKEN (checks: write, pull-requests: read on this repo),
 * LAYOUT_TOKEN (optional: reads the PRIVATE repos a dependency may live in),
 * GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH; HOLD_DRY_RUN=1 judges
 * and logs without posting.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAll,
  githubClient,
  loadLayout,
  parseDependsOn,
  repoNamed,
  verdictOf,
} from "./layout.mjs";

export const CHECK_NAME = "Dependencies merged";

/** The check run a set of results asks for: { status, conclusion?, title, summary }. */
export function checkFor(results) {
  const verdict = verdictOf(results);
  const rows = results.map(
    (r) => `| ${r.status} | \`${r.dep.label}\` | ${r.detail} |`
  );
  const table = rows.length
    ? `| | Dependency | State |\n|---|---|---|\n${rows.join("\n")}\n\n`
    : "";
  const how =
    "Declare a dependency with one line per dependency in the PR body: `Depends-On: <repo>#<n>` " +
    "(a pull request) or `Depends-On: <repo>@<sha>` (a commit of a direct-commit repo). " +
    "Repo names: scripts/layout/layout.json. Editing the body re-runs this check; " +
    "a held PR is released by the sweep when its dependency lands.";
  if (verdict === "landed") {
    return {
      status: "completed",
      conclusion: "success",
      title: results.length
        ? `All ${results.length} dependencies landed`
        : "No dependencies",
      summary: `${table}${how}`,
    };
  }
  const first = results.find((r) => r.status === verdict);
  if (verdict === "blocked") {
    return {
      status: "completed",
      conclusion: "failure",
      title: `Cannot land: ${first.dep.label}`.slice(0, 120),
      summary: `${table}${how}`,
    };
  }
  const waiting = results
    .filter((r) => r.status === "waiting")
    .map((r) => r.dep.label);
  return {
    status: "in_progress",
    title: `Waiting for ${waiting.join(", ")}`.slice(0, 120),
    summary: `${table}${how}`,
  };
}

/** Whether the latest check run already says what `want` says. */
export function sameCheck(latest, want) {
  if (!latest) return false;
  return (
    latest.status === want.status &&
    (latest.conclusion ?? null) === (want.conclusion ?? null) &&
    latest.output?.title === want.title
  );
}

/** The PR number of a merge-queue branch: gh-readonly-queue/<base>/pr-<n>-<sha>. */
export function queuePrNumber(headRef) {
  const m = /\/pr-(\d+)-[0-9a-f]+$/.exec(String(headRef ?? ""));
  return m ? Number(m[1]) : null;
}

function api(token) {
  async function call(method, path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "synap-depends-on",
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok)
      throw new Error(
        `${method} ${path}: HTTP ${res.status} ${await res.text()}`
      );
    return res.json();
  }
  return { call };
}

async function judge({ repo, sha, body, deps, own, layout, log, dryRun }) {
  const self = repoNamed(repo, layout)?.dir ?? null;
  const parsed = parseDependsOn(body, { self, layout });
  const results = await evaluateAll(parsed, deps, {
    defaultBranch: layout.defaultBranch,
  });
  const want = checkFor(results);
  const found = await own.call(
    "GET",
    `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest&per_page=1`
  );
  const latest = found.check_runs?.[0] ?? null;
  if (sameCheck(latest, want)) {
    log(`${sha.slice(0, 9)}: unchanged (${want.title})`);
    return want;
  }
  if (dryRun) {
    log(
      `${sha.slice(0, 9)}: WOULD post ${want.status}${want.conclusion ? `/${want.conclusion}` : ""} — ${want.title}`
    );
    return want;
  }
  await own.call("POST", `/repos/${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: sha,
    status: want.status,
    ...(want.conclusion ? { conclusion: want.conclusion } : {}),
    output: { title: want.title, summary: want.summary },
  });
  log(
    `${sha.slice(0, 9)}: ${want.status}${want.conclusion ? `/${want.conclusion}` : ""} — ${want.title}`
  );
  return want;
}

export async function main(env = process.env, log = console.log) {
  const repo = env.GITHUB_REPOSITORY;
  const event = env.GITHUB_EVENT_NAME;
  const payload = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const layout = loadLayout();
  const own = api(env.GITHUB_TOKEN);
  // Public repos (this one included) read with the job's token; private ones
  // need the Reader App's. Without it a private dependency reads as "could not
  // read" and HOLDS, never as landed.
  const deps = githubClient({
    tokenFor: (r) =>
      repoNamed(r, layout)?.public
        ? env.GITHUB_TOKEN
        : env.LAYOUT_TOKEN || env.GITHUB_TOKEN,
  });
  // HOLD_DRY_RUN=1: read and judge, post nothing (to try it from a laptop).
  const ctx = {
    repo,
    deps,
    own,
    layout,
    log,
    dryRun: env.HOLD_DRY_RUN === "1",
  };

  if (event === "pull_request_target" || event === "pull_request") {
    const pr = payload.pull_request;
    await judge({ ...ctx, sha: pr.head.sha, body: pr.body ?? "" });
    return 0;
  }
  if (event === "merge_group") {
    const mg = payload.merge_group;
    const n = queuePrNumber(mg.head_ref);
    if (!n) {
      await own.call("POST", `/repos/${repo}/check-runs`, {
        name: CHECK_NAME,
        head_sha: mg.head_sha,
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Unknown merge-queue branch",
          summary: `Could not read a PR number from ${mg.head_ref}; scripts/layout/hold.mjs queuePrNumber expects gh-readonly-queue/<base>/pr-<n>-<sha>.`,
        },
      });
      return 1;
    }
    const pr = await own.call("GET", `/repos/${repo}/pulls/${n}`);
    await judge({ ...ctx, sha: mg.head_sha, body: pr.body ?? "" });
    return 0;
  }
  // push / schedule / workflow_dispatch: sweep every open PR.
  let page = 1;
  let n = 0;
  for (;;) {
    const prs = await own.call(
      "GET",
      `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`
    );
    for (const pr of prs) {
      n++;
      try {
        await judge({
          ...ctx,
          sha: pr.head.sha,
          body: pr.body ?? "",
          log: (l) => log(`#${pr.number} ${l}`),
        });
      } catch (e) {
        log(`#${pr.number} ✗ ${e.message}`);
      }
    }
    if (prs.length < 100 || page >= 5) break;
    page++;
  }
  log(`swept ${n} open PR(s)`);
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  );
}
