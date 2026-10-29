#!/usr/bin/env node
/**
 * merge-bot.mjs: the backend merge bot (founder, 2026-10-29 ~11:35Z).
 * ===================================================================
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * Measured 2026-10-29: 0 of 292 backend merges since 20 Oct went through the
 * merge queue (0 of 73 merge_group head shas are on main). Every merge was an
 * admin bypass by the founder, the only person allowed to land. Overnight
 * 28→29 Oct, 5 PRs bypass-merged at 01:00Z made main red; the fix (#489) was
 * green at 01:55Z and waited 8 h for the founder to wake (merged 09:54Z). In
 * that window 33 PR CI runs ran and 0 were green, and once main was fixed
 * nothing re-ran the PRs that were red only because of main.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 * A. ENQUEUE. A PR enters the merge queue (GraphQL `enqueuePullRequest`, with
 *    `expectedHeadOid` = the head the checks judged) when ALL hold
 *    (enqueueReasons): open, base main, not a draft, not a `negctl/*` branch,
 *    not dependabot, not from a fork, its body has a `Pod session: <uuid>`
 *    line, every `Depends-On:` line has landed (scripts/layout/layout.mjs, the
 *    resolver the "Dependencies merged" hold uses), the 4 required checks
 *    (release-gate-wait.mjs REQUIRED_CHECKS, posted by GitHub Actions) are
 *    `success` on its head sha, it is not CONFLICTING, and it is not already
 *    queued. It never merges, never uses admin, never calls `gh pr merge`.
 * B. A MAIN-RED FIX JUMPS. A PR whose branch is `fix/main-red-*`, or whose
 *    title starts `fix: main red` / `fix(<scope>): main red`, is enqueued with
 *    `jump: true` (front of the queue; GitHub rebuilds the groups in flight).
 *    If GitHub refuses the jump, it is enqueued without it, and said.
 * C. MAIN'S VICTIMS RUN AGAIN. When main's latest finished push run of CI is
 *    `success` and the one(s) before it `failure` (mainRedWindow), every open,
 *    non-draft PR whose latest CI run FAILED and was CREATED in the red window
 *    (from the first red run's creation, i.e. the red push, to the green run's
 *    end) gets ONE fresh CI run (victimReasons).
 *    NOT `gh run rerun --failed`: a re-run reuses the run's GITHUB_SHA, which
 *    for a pull_request run is GitHub's test merge AS IT WAS, red main
 *    included. Seen on run 40594912129: attempt 1 (22:31Z) and attempt 2
 *    (00:23Z) both checked out `8ffc467 Merge 9052fa2 into bc1ac5e`, while
 *    main had moved on to 9969f07. So the bot marks the PR draft and ready
 *    again: `ready_for_review` is a ci.yml trigger, and that new run tests the
 *    PR merged into TODAY's main. Nothing is pushed; the branch is never
 *    updated. Before it does, it checks GitHub's test merge is already built
 *    on main's current tip (else the next sweep does it).
 *    ONCE per main red: after the toggle it posts a neutral check run
 *    "Re-run after main green" on the PR's head with external_id
 *    `main-green-<green run id>`; a PR carrying it for that green run is
 *    skipped. (A toggled PR's newest run is also created after the window, so
 *    it no longer reads as a victim either.)
 *
 * ── IDENTITY ─────────────────────────────────────────────────────────────────
 * Events made with the Actions GITHUB_TOKEN start no workflow run (except
 * workflow_dispatch and repository_dispatch; docs "GITHUB_TOKEN"). A
 * merge_group run is attributed to whoever enqueued (74 of 74 merge_group CI
 * runs on 29 Oct name the enqueuer as actor), so a GITHUB_TOKEN enqueue would
 * queue a PR whose required checks never start; the same holds for a
 * GITHUB_TOKEN ready_for_review. Every WRITE that must start CI therefore uses
 * the "Synap Merge Bot" GitHub App's installation token (MERGE_BOT_TOKEN:
 * contents + pull requests write, installed on backend only, NOT on the
 * ruleset's bypass list). Reads, and the marker check run, use the job's
 * GITHUB_TOKEN (GH_TOKEN).
 * FAIL-SAFE: no MERGE_BOT_TOKEN (the app or its secrets absent, or the mint
 * failed) = judge and log everything, write nothing, exit 0.
 *
 * ── WHEN ─────────────────────────────────────────────────────────────────────
 * .github/workflows/merge-bot.yml: on every completed CI run (a PR's run
 * judges that PR only; a main push run sweeps), every 15 min and on demand
 * (sweep). A sweep runs C, then A over every open PR.
 *
 * Env: GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GH_TOKEN
 * (reads, checks: write), MERGE_BOT_TOKEN (writes), LAYOUT_TOKEN (optional:
 * the Reader App, to read a private repo's Depends-On target),
 * MERGE_BOT_DRY_RUN=true|1 (judge, write nothing). `--dry-run` likewise.
 * Transport: the `gh` CLI (`gh api`), so the tripwire drives it with a fake.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  evaluateAll,
  githubClient,
  loadLayout,
  parseDependsOn,
  repoNamed,
  verdictOf,
} from "../layout/layout.mjs";
import { CI_WORKFLOW, REQUIRED_CHECKS } from "./release-gate-wait.mjs";

/** The GitHub Actions app: the only integration whose checks the ruleset reads. */
export const GITHUB_ACTIONS_APP_ID = 15368;
/** The once-only marker posted on a re-run PR's head. */
export const RERUN_CHECK_NAME = "Re-run after main green";
/** A red window older than this is history: no victim is looked for. */
export const WINDOW_MAX_AGE_HOURS = 24;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const POD_SESSION_LINE = new RegExp(
  `^[ \\t]*Pod session:[ \\t]*\`?(${UUID})\\b`,
  "i"
);

/**
 * The `Pod session: <uuid>` of a PR body, or null. One line, at its start
 * (text may follow the id); lines inside ``` / ~~~ fences are ignored, like
 * Depends-On lines (layout.mjs parseDependsOn).
 */
export function podSessionOf(body) {
  let fenced = false;
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    if (/^[ \t]*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = POD_SESSION_LINE.exec(raw);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** A main-red fix: branch `fix/main-red-*`, or title `fix: main red…` / `fix(x): main red…`. */
export function isMainRedFix(pr) {
  if (/^fix\/main-red-/i.test(pr?.headRefName ?? "")) return true;
  return /^fix(\([^)]*\))?!?:[ \t]*main red\b/i.test(
    String(pr?.title ?? "").trim()
  );
}

export function isDependabot(pr) {
  const login = String(pr?.author?.login ?? "").toLowerCase();
  return (
    login === "dependabot" ||
    login === "dependabot[bot]" ||
    /^dependabot\//.test(pr?.headRefName ?? "")
  );
}

/**
 * The required checks on one head sha. `checkRuns` = the check runs GitHub
 * returns for that commit; only GitHub Actions' (app 15368) count, the latest
 * of each name. Returns { ok, missing: [name], notGreen: ["name: state"] }.
 */
export function requiredChecksState(checkRuns, headSha) {
  const latest = new Map();
  for (const c of checkRuns ?? []) {
    if (c?.app?.id !== GITHUB_ACTIONS_APP_ID) continue;
    if (headSha && c.head_sha && c.head_sha !== headSha) continue;
    if (!REQUIRED_CHECKS.includes(c.name)) continue;
    const prev = latest.get(c.name);
    const at = (x) => `${x.started_at ?? ""}|${String(x.id).padStart(20, "0")}`;
    if (!prev || at(c) > at(prev)) latest.set(c.name, c);
  }
  const missing = [];
  const notGreen = [];
  for (const name of REQUIRED_CHECKS) {
    const c = latest.get(name);
    if (!c) missing.push(name);
    else if (c.status !== "completed" || c.conclusion !== "success")
      notGreen.push(
        `${name}: ${c.status === "completed" ? c.conclusion : c.status}`
      );
  }
  return { ok: !missing.length && !notGreen.length, missing, notGreen };
}

/**
 * Why a PR is NOT enqueued (empty = enqueue). Pure. `pr` is the GraphQL
 * PullRequest shape read by listOpenPrs. `checks` (requiredChecksState) and
 * `depends` ("landed" | "waiting" | "blocked") are judged only when given: the
 * driver reads them for the PRs that pass the cheap gates, to spare the API.
 */
export function enqueueReasons({ pr, checks, depends }) {
  const r = [];
  if (pr.state && pr.state !== "OPEN") r.push(`state: ${pr.state}`);
  if (pr.baseRefName !== "main") r.push(`base: ${pr.baseRefName}, not main`);
  if (pr.isDraft) r.push("draft");
  if (/^negctl\//.test(pr.headRefName ?? "")) r.push("negctl branch");
  if (isDependabot(pr)) r.push("dependabot");
  if (pr.isCrossRepository) r.push("from a fork");
  if (!podSessionOf(pr.body)) r.push("no `Pod session: <uuid>` line");
  if (pr.mergeable === "CONFLICTING") r.push("conflicting");
  if (pr.isInMergeQueue) r.push("already queued");
  if (depends !== undefined && depends !== "landed")
    r.push(`Depends-On: ${depends}`);
  if (checks !== undefined && !checks.ok)
    r.push(
      `required checks: ${[...checks.missing.map((n) => `${n}: none`), ...checks.notGreen].join(", ")}`
    );
  return r;
}

/**
 * The enqueue verdict once every input is read. Pure.
 * @returns {{ enqueue: boolean, jump: boolean, reasons: string[] }}
 */
export function enqueueDecision({ pr, checks, depends }) {
  const reasons = enqueueReasons({ pr, checks, depends });
  if (checks === undefined) reasons.push("required checks: not read");
  if (depends === undefined) reasons.push("Depends-On: not read");
  return { enqueue: reasons.length === 0, jump: isMainRedFix(pr), reasons };
}

const at = (x) => Date.parse(x ?? "") || 0;

/**
 * The latest red→green transition of main, or null. `runs` = CI push runs on
 * main (any order, any status). Only finished runs that succeeded or failed
 * count (a cancelled or skipped run says nothing about main). Null when the
 * latest finished run is not a success, when no failure precedes it, or when
 * it ended more than WINDOW_MAX_AGE_HOURS ago.
 * Window: [the first red run's created_at (the red push), the green run's end].
 */
export function mainRedWindow(
  runs,
  { now = Date.now(), maxAgeHours = WINDOW_MAX_AGE_HOURS } = {}
) {
  const done = (runs ?? [])
    .filter(
      (r) =>
        r.event === "push" &&
        r.head_branch === "main" &&
        r.status === "completed" &&
        (r.conclusion === "success" || r.conclusion === "failure")
    )
    .sort((a, b) => at(b.created_at) - at(a.created_at));
  const green = done[0];
  if (!green || green.conclusion !== "success") return null;
  const streak = [];
  for (const r of done.slice(1)) {
    if (r.conclusion !== "failure") break;
    streak.push(r);
  }
  if (!streak.length) return null;
  const end = green.updated_at ?? green.created_at;
  if (now - at(end) > maxAgeHours * 3600_000) return null;
  const firstRed = streak[streak.length - 1];
  return {
    green,
    firstRed,
    lastRed: streak[0],
    start: firstRed.created_at,
    end,
    key: `main-green-${green.id}`,
  };
}

/**
 * Why a PR is NOT a victim to run again (empty = run it again). Pure. Each
 * input is judged only when given (`undefined` = not read yet), so the driver
 * reads lazily; victimDecision judges them all.
 *   latestRun  the PR's latest ci.yml pull_request run of its head (or null);
 *   markers    the "Re-run after main green" check runs on its head;
 *   merge      { mergeable, baseSha, mainSha }: GitHub's test merge of the PR,
 *              the main commit it is built on, and main's tip now.
 */
export function victimReasons({ pr, window, latestRun, markers, merge }) {
  const r = [];
  if (!window) r.push("main is not just back to green");
  if (pr.state && pr.state !== "OPEN") r.push(`state: ${pr.state}`);
  if (pr.baseRefName !== "main") r.push(`base: ${pr.baseRefName}, not main`);
  if (pr.isDraft) r.push("draft");
  if (/^negctl\//.test(pr.headRefName ?? "")) r.push("negctl branch");
  if (pr.isCrossRepository) r.push("from a fork");
  if (latestRun === null) r.push("no CI run of its head");
  if (latestRun) {
    if (latestRun.head_sha !== pr.headRefOid)
      r.push("its latest run is of another commit");
    if (latestRun.status !== "completed")
      r.push(`its run is ${latestRun.status}`);
    else if (latestRun.conclusion !== "failure")
      r.push(`its run ended ${latestRun.conclusion}`);
    if (
      window &&
      (at(latestRun.created_at) < at(window.start) ||
        at(latestRun.created_at) > at(window.end))
    )
      r.push("its run was not created while main was red");
  }
  if (markers && window && markers.some((m) => m.external_id === window.key))
    r.push(`already run again for ${window.key}`);
  if (merge) {
    if (merge.mergeable !== true)
      r.push(`test merge not ready (mergeable: ${merge.mergeable})`);
    else if (!merge.baseSha || merge.baseSha !== merge.mainSha)
      r.push("test merge not yet rebuilt on main's tip");
  }
  return r;
}

/** The victim verdict once every input is read. Pure. */
export function victimDecision(input) {
  const reasons = victimReasons(input);
  for (const k of ["latestRun", "markers", "merge"])
    if (input[k] === undefined) reasons.push(`${k}: not read`);
  return { rerun: reasons.length === 0, reasons };
}

// ── transport ───────────────────────────────────────────────────────────────

/** `gh api` as JSON. A failed call throws with gh's stderr. */
export function ghTransport({ ghBin = "gh", env = process.env } = {}) {
  function call(args, { token, input } = {}) {
    try {
      const out = execFileSync(ghBin, args, {
        env: { ...env, GH_TOKEN: token ?? "" },
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      return out.trim() ? JSON.parse(out) : null;
    } catch (e) {
      const msg = String(e.stderr || e.message || e).trim();
      throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${msg}`);
    }
  }
  return {
    rest: (path, { token, method = "GET", body } = {}) =>
      call(["api", "-X", method, path, ...(body ? ["--input", "-"] : [])], {
        token,
        input: body ? JSON.stringify(body) : undefined,
      }),
    graphql: (query, vars, { token } = {}) =>
      call(
        [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          ...Object.entries(vars ?? {}).flatMap(([k, v]) =>
            v === undefined || v === null
              ? []
              : typeof v === "string"
                ? ["-f", `${k}=${v}`]
                : ["-F", `${k}=${v}`]
          ),
        ],
        { token }
      ),
  };
}

const PRS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title body state isDraft baseRefName headRefName headRefOid
        isCrossRepository mergeable isInMergeQueue
        author { login }
      }
    }
  }
}`;

const ENQUEUE = `mutation($id: ID!, $oid: GitObjectID!, $jump: Boolean) {
  enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid, jump: $jump}) {
    mergeQueueEntry { position state }
  }
}`;
const TO_DRAFT = `mutation($id: ID!) {
  convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } }
}`;
const TO_READY = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } }
}`;

/** Every open PR of the repo (GraphQL, 50 a page, at most 10 pages). */
export function listOpenPrs(gh, repo, token) {
  const [owner, name] = repo.split("/");
  const prs = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const d = gh.graphql(PRS_QUERY, { owner, name, after }, { token });
    const conn = d?.data?.repository?.pullRequests;
    if (!conn) throw new Error("open PRs: no pullRequests in the reply");
    prs.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return prs;
}

/** The Depends-On verdict of a PR body, through the layout resolver. */
export function layoutDepends(env) {
  const layout = loadLayout();
  const client = githubClient({
    tokenFor: (r) =>
      repoNamed(r, layout)?.public
        ? env.GH_TOKEN || env.GITHUB_TOKEN
        : env.LAYOUT_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN,
  });
  return async (pr, repo) => {
    const self = repoNamed(repo, layout)?.dir ?? null;
    const parsed = parseDependsOn(pr.body ?? "", { self, layout });
    const results = await evaluateAll(parsed, client, {
      defaultBranch: layout.defaultBranch,
    });
    return verdictOf(results);
  };
}

// ── driver ──────────────────────────────────────────────────────────────────

/**
 * One pass. Returns { code, enqueued: [n], rerun: [n], failures }.
 * `dependsOf(pr, repo)` → "landed" | "waiting" | "blocked" (default: layout).
 */
export async function runBot({
  env = process.env,
  argv = process.argv,
  log = console.log,
  gh = ghTransport({ env }),
  dependsOf = null,
  now = Date.now(),
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const readToken = env.GH_TOKEN || env.GITHUB_TOKEN || "";
  const botToken = env.MERGE_BOT_TOKEN || "";
  const event = env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const payload = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const askedDry =
    argv.includes("--dry-run") ||
    env.MERGE_BOT_DRY_RUN === "true" ||
    env.MERGE_BOT_DRY_RUN === "1";
  const dryRun = askedDry || !botToken;
  const out = { code: 0, enqueued: [], rerun: [], failures: 0 };
  if (!repo) {
    log("::warning::no GITHUB_REPOSITORY: nothing to do");
    return out;
  }
  if (!botToken)
    log(
      "::warning::The Synap Merge Bot app token is absent (secrets SYNAP_MERGE_BOT_APP_ID / SYNAP_MERGE_BOT_KEY unset, or the mint failed): judging only, nothing is enqueued or run again."
    );
  else if (askedDry) log("dry run: judging only, nothing is written");
  const depends = dependsOf ?? layoutDepends(env);

  // A PR's own CI run judges that PR only; anything else sweeps.
  const wr = payload.workflow_run;
  const prMode = event === "workflow_run" && wr?.event === "pull_request";
  let prs;
  try {
    prs = listOpenPrs(gh, repo, readToken);
  } catch (e) {
    log(`::warning::could not list the open PRs (${e.message}); nothing done`);
    return out;
  }
  if (prMode) prs = prs.filter((p) => p.headRefOid === wr.head_sha);
  log(
    `${prMode ? `CI run ${wr.id} of ${String(wr.head_sha).slice(0, 9)}` : `sweep (${event})`}: ${prs.length} open PR(s)`
  );

  if (!prMode)
    await victims({
      gh,
      repo,
      prs,
      readToken,
      botToken,
      dryRun,
      log,
      now,
      out,
    });

  // A + B: main-red fixes first, then the oldest first.
  const ordered = [...prs].sort(
    (a, b) => Number(isMainRedFix(b)) - Number(isMainRedFix(a))
  );
  for (const pr of ordered) {
    const tag = `#${pr.number}`;
    const cheap = enqueueReasons({ pr });
    if (cheap.length) {
      log(`${tag} not enqueued: ${cheap.join("; ")}`);
      continue;
    }
    let d;
    try {
      const runs = gh.rest(
        `repos/${repo}/commits/${pr.headRefOid}/check-runs?filter=latest&per_page=100`,
        { token: readToken }
      );
      const checks = requiredChecksState(runs?.check_runs, pr.headRefOid);
      // Depends-On is read only for a PR whose checks are green (it may cost
      // a read per dependency, in another repo).
      d = checks.ok
        ? enqueueDecision({ pr, checks, depends: await depends(pr, repo) })
        : { enqueue: false, reasons: enqueueReasons({ pr, checks }) };
    } catch (e) {
      log(`${tag} not enqueued: a read failed (${e.message})`);
      continue;
    }
    if (!d.enqueue) {
      log(`${tag} not enqueued: ${d.reasons.join("; ")}`);
      continue;
    }
    if (dryRun) {
      log(
        `${tag} WOULD enqueue${d.jump ? " with jump (main-red fix)" : ""} at ${pr.headRefOid.slice(0, 9)}`
      );
      continue;
    }
    const r = enqueue(gh, pr, d.jump, botToken, log);
    if (r) out.enqueued.push(pr.number);
    else out.failures++;
  }
  log(
    `done: ${out.enqueued.length} enqueued${out.enqueued.length ? ` (#${out.enqueued.join(", #")})` : ""}, ${out.rerun.length} run again${out.rerun.length ? ` (#${out.rerun.join(", #")})` : ""}, ${out.failures} write(s) failed`
  );
  out.code = out.failures ? 1 : 0;
  return out;
}

/**
 * Enqueue one PR with the bot's token. A jump GitHub refuses is retried
 * without it (a main-red fix still enters the queue). True when it entered.
 */
function enqueue(gh, pr, jump, token, log) {
  const tag = `#${pr.number}`;
  const vars = { id: pr.id, oid: pr.headRefOid };
  try {
    const res = gh.graphql(ENQUEUE, { ...vars, jump }, { token });
    const e = res?.data?.enqueuePullRequest?.mergeQueueEntry;
    log(
      `${tag} enqueued${jump ? " at the front (main-red fix)" : ""}: position ${e?.position ?? "?"}, ${e?.state ?? "?"}`
    );
    return true;
  } catch (first) {
    if (!jump) {
      log(`::warning::${tag} could not be enqueued: ${first.message}`);
      return false;
    }
    log(
      `::warning::${tag} could not jump the queue (${first.message}); enqueuing it without the jump`
    );
  }
  try {
    gh.graphql(ENQUEUE, { ...vars, jump: false }, { token });
    log(`${tag} enqueued (no jump)`);
    return true;
  } catch (e) {
    log(`::warning::${tag} could not be enqueued: ${e.message}`);
    return false;
  }
}

async function victims({
  gh,
  repo,
  prs,
  readToken,
  botToken,
  dryRun,
  log,
  now,
  out,
}) {
  let window;
  try {
    const main = gh.rest(
      `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&event=push&per_page=30`,
      { token: readToken }
    );
    window = mainRedWindow(main?.workflow_runs, { now });
  } catch (e) {
    log(
      `::warning::could not read main's CI runs (${e.message}); no victim run again`
    );
    return;
  }
  if (!window) {
    log("main: no red→green transition to answer");
    return;
  }
  log(
    `main went green in run ${window.green.id} after ${window.firstRed.id === window.lastRed.id ? `red run ${window.lastRed.id}` : `red runs ${window.firstRed.id}…${window.lastRed.id}`}: window ${window.start} → ${window.end}`
  );
  let mainSha;
  for (const pr of prs) {
    const tag = `#${pr.number}`;
    if (victimReasons({ pr, window }).length) continue;
    try {
      const runs =
        gh.rest(
          `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?event=pull_request&head_sha=${pr.headRefOid}&per_page=20`,
          { token: readToken }
        )?.workflow_runs ?? [];
      const latestRun =
        [...runs].sort((a, b) => at(b.created_at) - at(a.created_at))[0] ??
        null;
      let why = victimReasons({ pr, window, latestRun });
      if (why.length) {
        if (latestRun?.conclusion === "failure")
          log(`${tag} not run again: ${why.join("; ")}`);
        continue;
      }
      const markers =
        gh.rest(
          `repos/${repo}/commits/${pr.headRefOid}/check-runs?check_name=${encodeURIComponent(RERUN_CHECK_NAME)}&per_page=100`,
          { token: readToken }
        )?.check_runs ?? [];
      why = victimReasons({ pr, window, latestRun, markers });
      if (why.length) {
        log(`${tag} not run again: ${why.join("; ")}`);
        continue;
      }
      mainSha ??= gh.rest(`repos/${repo}/git/ref/heads/main`, {
        token: readToken,
      })?.object?.sha;
      const p = gh.rest(`repos/${repo}/pulls/${pr.number}`, {
        token: readToken,
      });
      let baseSha = null;
      if (p?.mergeable === true && p.merge_commit_sha)
        baseSha =
          gh.rest(`repos/${repo}/commits/${p.merge_commit_sha}`, {
            token: readToken,
          })?.parents?.[0]?.sha ?? null;
      const d = victimDecision({
        pr,
        window,
        latestRun,
        markers,
        merge: { mergeable: p?.mergeable ?? null, baseSha, mainSha },
      });
      if (!d.rerun) {
        log(`${tag} not run again: ${d.reasons.join("; ")}`);
        continue;
      }
      if (dryRun) {
        log(
          `${tag} WOULD run CI again (run ${latestRun.id} failed while main was red)`
        );
        continue;
      }
      toggleReady(gh, pr, botToken);
      out.rerun.push(pr.number);
      log(
        `${tag} CI started again (draft → ready); run ${latestRun.id} failed while main was red`
      );
      try {
        gh.rest(`repos/${repo}/check-runs`, {
          token: readToken,
          method: "POST",
          body: {
            name: RERUN_CHECK_NAME,
            head_sha: pr.headRefOid,
            status: "completed",
            conclusion: "neutral",
            external_id: window.key,
            output: {
              title: `CI run again after main went green (run ${window.green.id})`,
              summary: `Run ${latestRun.id} failed while main was red (runs ${window.firstRed.id}…${window.lastRed.id}). The merge bot marked this PR draft and ready again so CI tests it on today's main (scripts/ci/merge-bot.mjs). Once per main red.`,
            },
          },
        });
      } catch (e) {
        log(
          `::warning::${tag} the once-only marker could not be posted (${e.message}); its new run, created after the window, still keeps it from a second time`
        );
      }
    } catch (e) {
      out.failures++;
      log(`::error::${tag} victim: ${e.message}`);
    }
  }
}

/** Draft, then ready: a fresh `ready_for_review` CI run. Ready is retried: a PR is never left a draft quietly. */
function toggleReady(gh, pr, token) {
  gh.graphql(TO_DRAFT, { id: pr.id }, { token });
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      gh.graphql(TO_READY, { id: pr.id }, { token });
      return;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(
    `#${pr.number} was marked draft but could not be marked ready again (${last.message}): mark it ready by hand`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runBot().then(
    (r) => process.exit(r.code),
    (e) => {
      console.log(`::error::merge bot crashed: ${e.message}`);
      process.exit(1);
    }
  );
}
