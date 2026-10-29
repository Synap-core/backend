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
 * A dependency on a PR of THIS repo may RIDE the merge queue (founder,
 * 2026-10-29, merge bot): Zuul's "test together, land in order".
 *   - On the PR (pull_request_target, sweep): a dependency that is IN the merge
 *     queue counts (rideTheQueue), so the dependent may queue behind it.
 *     Only while this check is REQUIRED (main's live rules): otherwise nothing
 *     would hold the dependent in the queue, so it stays waiting.
 *   - In the queue (merge_group): it counts only when the group's first-parent
 *     line MERGES the dependency's current head (rideInGroup): the group then tests
 *     both together and the queue lands them in order. If the dependency leaves
 *     the queue, the group is rebuilt without it and the dependent is held again.
 * A dependency in another repo never rides: it must be on its main.
 * This holds only if "Dependencies merged" is a REQUIRED check; the merge bot
 * lets a dependent ride only when the live ruleset says so.
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

const sameRepoWaitingPr = (r, repo) =>
  r.status === "waiting" &&
  r.dep?.kind === "pr" &&
  String(r.dep.repo ?? "").toLowerCase() === String(repo ?? "").toLowerCase();

/**
 * PR level: a waiting dependency on a PR of `repo` that is in the merge queue
 * counts as landed for this check (`rides: "queue"`). `queued` = Map of PR
 * number -> head sha of the PRs in the queue. Pure.
 */
export function rideTheQueue(results, { repo, queued }) {
  return results.map((r) => {
    if (!sameRepoWaitingPr(r, repo) || !queued?.has(r.dep.number)) return r;
    return {
      ...r,
      status: "landed",
      rides: "queue",
      detail: `in the merge queue (head ${String(queued.get(r.dep.number) ?? "").slice(0, 9)}): this PR may queue behind it; its queue run is held unless both are in one group`,
    };
  });
}

/**
 * merge_group: a waiting dependency on a PR of `repo` counts as landed when
 * the group's base..head commits hold the queue's MERGE of its current head:
 * a commit whose second parent is that head (the queue merges each entry with
 * parents [previous, PR head]; seen on aa8f854fa, "Merge pull request #485",
 * parents 409270a3d,dd3a7bb19). A commit that merely CONTAINS the dependency's
 * commits (a branch stacked on it) does not count: that change has not passed
 * the queue. `heads` = Map of PR number -> current head sha. Pure.
 */
export function rideInGroup(results, { repo, groupCommits, heads, headSha }) {
  // Only the group's own line: the queue's merges sit on the FIRST-parent
  // chain from its head. A merge inside a PR's branch (`git merge <dep>` by
  // its author) is reached through a second parent, never on that chain.
  const bySha = new Map((groupCommits ?? []).map((c) => [c?.sha, c]));
  const line = [];
  for (let c = bySha.get(headSha); c; c = bySha.get(c.parents?.[0]?.sha)) {
    line.push(c);
    if (line.length > bySha.size) break;
  }
  return results.map((r) => {
    if (!sameRepoWaitingPr(r, repo)) return r;
    const head = heads?.get(r.dep.number);
    if (!head) return r;
    const merge = line.find((c) => c?.parents?.[1]?.sha === head);
    if (!merge) return r;
    return {
      ...r,
      status: "landed",
      rides: "group",
      detail: `in this merge-queue group (${String(merge.sha).slice(0, 9)} merges its head ${head.slice(0, 9)}): they land together, in order`,
    };
  });
}

/**
 * The required status check names of a branch's rules (REST
 * GET /repos/{repo}/rules/branches/{branch}). The one parse: the merge bot
 * reads main's live required checks through it too.
 */
export function requiredContextsOf(rules) {
  if (!Array.isArray(rules)) throw new Error("rules: not a list");
  return rules
    .filter((r) => r?.type === "required_status_checks")
    .flatMap((r) => r.parameters?.required_status_checks ?? [])
    .map((c) => c.context);
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

async function judge({
  repo,
  sha,
  body,
  deps,
  own,
  layout,
  log,
  dryRun,
  adjust = async (r) => r,
}) {
  const self = repoNamed(repo, layout)?.dir ?? null;
  const parsed = parseDependsOn(body, { self, layout });
  const results = await adjust(
    await evaluateAll(parsed, deps, {
      defaultBranch: layout.defaultBranch,
    })
  );
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

const QUEUE_STATE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { isInMergeQueue headRefOid }
  }
}`;

/** PR level: the waiting same-repo PR dependencies in the queue ride. A failed read leaves them waiting. */
export function queueAdjust(own, repo, log) {
  return async (results) => {
    if (!results.some((r) => sameRepoWaitingPr(r, repo))) return results;
    // A queued dependency counts on the PR only while this check is REQUIRED
    // (riding on): otherwise "landed" would tell whoever reads it before
    // prcheck that a PR is ready while nothing holds it in the queue.
    let required = false;
    try {
      required = requiredContextsOf(
        await own.call("GET", `/repos/${repo}/rules/branches/main`)
      ).includes(CHECK_NAME);
    } catch (e) {
      log(`could not read main's required checks (${e.message}); no riding`);
    }
    if (!required) return results;
    const [owner, name] = repo.split("/");
    const queued = new Map();
    for (const r of results) {
      if (!sameRepoWaitingPr(r, repo)) continue;
      try {
        const d = await own.call("POST", "/graphql", {
          query: QUEUE_STATE,
          variables: { owner, name, number: r.dep.number },
        });
        const p = d?.data?.repository?.pullRequest;
        if (p?.isInMergeQueue) queued.set(r.dep.number, p.headRefOid);
      } catch (e) {
        log(
          `could not read whether #${r.dep.number} is queued (${e.message}); it stays waiting`
        );
      }
    }
    return rideTheQueue(results, { repo, queued });
  };
}

/** merge_group: the waiting same-repo PR dependencies this group merges ride. A failed read leaves them waiting. */
export function groupAdjust(own, repo, mg, log) {
  return async (results) => {
    if (!results.some((r) => sameRepoWaitingPr(r, repo))) return results;
    try {
      const cmp = await own.call(
        "GET",
        `/repos/${repo}/compare/${mg.base_sha}...${mg.head_sha}`
      );
      const heads = new Map();
      for (const r of results) {
        if (!sameRepoWaitingPr(r, repo)) continue;
        const p = await own.call("GET", `/repos/${repo}/pulls/${r.dep.number}`);
        if (p?.head?.sha) heads.set(r.dep.number, p.head.sha);
      }
      return rideInGroup(results, {
        repo,
        groupCommits: cmp?.commits,
        heads,
        headSha: mg.head_sha,
      });
    } catch (e) {
      log(
        `could not read the group's commits (${e.message}); its dependencies stay waiting`
      );
      return results;
    }
  };
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
    await judge({
      ...ctx,
      sha: pr.head.sha,
      body: pr.body ?? "",
      adjust: queueAdjust(own, repo, log),
    });
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
    await judge({
      ...ctx,
      sha: mg.head_sha,
      body: pr.body ?? "",
      adjust: groupAdjust(own, repo, mg, log),
    });
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
          adjust: queueAdjust(own, repo, log),
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
