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
 *    (enqueueReasons):
 *      - the shared PR gates (prGates): open, base main, not a draft, not a
 *        `negctl/*` branch, not from a fork;
 *      - not dependabot; its body names a pod session (podSessionFromBody,
 *        scripts/pod-observation.mjs: the one parser of that line);
 *      - it is not CONFLICTING and not already queued;
 *      - every live required check of main (at least release-gate-wait.mjs
 *        REQUIRED_CHECKS), posted by GitHub Actions, is `success` on its head;
 *      - every `Depends-On:` line has landed, or rides (C);
 *      - it touches no CI or test infrastructure (INFRA_PATHS): a PR that
 *        edits what judges it could certify itself, so it needs the founder
 *        (`prcheck`);
 *      - main is not red, unless the PR jumps (B): while main's latest
 *        finished push run failed, only jumpers are enqueued (founder default,
 *        2026-10-29; MERGE_BOT_ENQUEUE_WHILE_RED=true overrides it).
 *    It never merges, never uses admin, never calls `gh pr merge`.
 * B. JUMP (jumpReason): enqueued with `jump: true` (front of the queue; GitHub
 *    rebuilds the groups in flight):
 *      - while main is red: a main-red fix (branch `fix/main-red-*`, the
 *        culprit finder's `fix/main-red-revert-*` included; or a title
 *        `fix: main red` / `fix(<scope>): main red`) or a revert (a title
 *        starting `Revert "`, GitHub's revert button);
 *      - at any time: a PR labelled `security` (labels need triage rights; a
 *        branch or a title anyone can write does not count).
 *    If GitHub refuses the jump, it is enqueued without it, and said. A PR
 *    that rides behind its dependency (C) never jumps ahead of it.
 * C. DEPENDENTS RIDE WITH THEIR DEPENDENCY. A PR whose only unmet Depends-On
 *    is an open PR of THIS repo already IN the merge queue is enqueued (behind
 *    it: the queue appends). The hold (scripts/layout/hold.mjs) lets its queue
 *    run pass only when the group's first-parent line merges the dependency's
 *    head, so both are tested together and land in order. Safe only when
 *    "Dependencies merged" is a REQUIRED check: riding is ON only when main's
 *    live rules say so (liveRequiredChecks); otherwise a dependent waits for
 *    its dependency to merge.
 * D. MAIN'S VICTIMS RUN AGAIN. After main's latest red→green transition of
 *    the last 24 h (mainRedWindow), every open, non-draft, non-queued PR whose
 *    latest CI run FAILED and was CREATED in the red window (from the first
 *    red push to the green run's end) gets ONE fresh CI run (victimReasons),
 *    at most MAX_TOGGLES_PER_SWEEP per sweep.
 *    NOT `gh run rerun --failed`: a re-run reuses the run's GITHUB_SHA, which
 *    for a pull_request run is GitHub's test merge AS IT WAS, red main
 *    included. Seen on run 40594912129: attempt 1 (22:31Z) and attempt 2
 *    (00:23Z) both checked out `8ffc467 Merge 9052fa2 into bc1ac5e`, while
 *    main had moved on to 9969f07. So the bot marks the PR draft and ready
 *    again: `ready_for_review` is a ci.yml trigger, and that new run tests the
 *    PR merged into TODAY's main. Nothing is pushed; the branch is never
 *    updated. Before it does, it checks GitHub's test merge is already built
 *    on main's current tip (else the next sweep does it). A queued PR is never
 *    toggled: a draft leaves the queue.
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
 * ruleset's bypass list; its secrets live only in environment `ci-bots`,
 * deployable from main only). Reads, and the marker check run, use the job's
 * GITHUB_TOKEN (GH_TOKEN).
 * FAIL-SAFE: no MERGE_BOT_TOKEN (the app or its secrets absent, or the mint
 * failed) = judge and log everything, write nothing, exit 0.
 *
 * ── WHEN ─────────────────────────────────────────────────────────────────────
 * .github/workflows/merge-bot.yml: on every completed CI run (a PR's run
 * judges that PR only; a main push run sweeps), every 15 min and on demand
 * (sweep). One concurrency group, so two passes never run at once. A sweep
 * runs D, then A over every open PR.
 *
 * Env: GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GH_TOKEN
 * (reads, checks: write), MERGE_BOT_TOKEN (writes), LAYOUT_TOKEN (optional:
 * the Reader App, to read a private repo's Depends-On target),
 * MERGE_BOT_DRY_RUN=true|1 (judge, write nothing; `--dry-run` likewise),
 * MERGE_BOT_ENQUEUE_WHILE_RED=true (override the red-main default of A).
 * Transport: the `gh` CLI (`gh api`), so the tripwire drives it with a fake.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  CHECK_NAME as HOLD_CHECK,
  requiredContextsOf,
  rideTheQueue,
} from "../layout/hold.mjs";
import {
  evaluateAll,
  githubClient,
  loadLayout,
  parseDependsOn,
  repoNamed,
  verdictOf,
} from "../layout/layout.mjs";
import { podSessionFromBody } from "../pod-observation.mjs";
import { CI_WORKFLOW, REQUIRED_CHECKS } from "./release-gate-wait.mjs";

/** The GitHub Actions app: the only integration whose checks the ruleset reads. */
export const GITHUB_ACTIONS_APP_ID = 15368;
/** The once-only marker posted on a re-run PR's head. */
export const RERUN_CHECK_NAME = "Re-run after main green";
/** A red window older than this is history: no victim is looked for. */
export const WINDOW_MAX_AGE_HOURS = 24;
/** At most this many victims get a fresh run per sweep (~6 jobs each, 20-job cap). */
export const MAX_TOGGLES_PER_SWEEP = 5;
/** The reason a PR that touches CI or test infrastructure is never enqueued. */
export const INFRA_REASON =
  "touches CI/test infrastructure: needs the founder (prcheck)";

/**
 * CI and test infrastructure: a PR touching any of these edits what judges it
 * (the workflows, the change-aware skips, the ratchet and its baseline, the
 * tripwire set, the verdict scripts, the test configs, the hooks), so it could
 * certify itself; it is left to the founder. One list, matched by
 * isInfraPath. The tripwire derives every script the workflows run and fails
 * on one this list does not classify.
 */
export const INFRA_PATHS = [
  /^\.github\//,
  /^\.husky\//,
  /^ci\//,
  /^scripts\/ci\//,
  /^scripts\/ci-changes\.mjs$/,
  /^scripts\/test-ratchet/, // the ratchet, its shards, retry and baseline
  /^scripts\/test-floors?\.[a-z]+$/, // the per-package test floors and their reader
  /^scripts\/layout\//, // the Depends-On hold and the CI sibling layout
  /^scripts\/tripwires?[^/]*\.mjs$/, // which tripwires run
  /^scripts\/preflight\.mjs$/, // the "Preflight red" hold
  /^scripts\/check-[^/]+\.mjs$/, // check-* verdict scripts CI runs
  /^scripts\/strip-comments\.mjs$/, // the import graph reads code through it (which tests a PR runs)
  /^scripts\/smoke-test\.sh$/,
  /(^|\/)vitest[^/]*\.config\.[^/]+$/,
  /^turbo\.json$/,
];

export const isInfraPath = (path) =>
  INFRA_PATHS.some((re) => re.test(String(path ?? "")));

/** The infrastructure paths among a PR's files (REST pulls/<n>/files; a rename counts both names). */
export function infraFilesOf(files) {
  const hits = new Set();
  for (const f of files ?? [])
    for (const p of [f?.filename, f?.previous_filename])
      if (p && isInfraPath(p)) hits.add(p);
  return [...hits];
}

/** A main-red fix: branch `fix/main-red-*`, or title `fix: main red…` / `fix(x): main red…`. */
export function isMainRedFix(pr) {
  if (/^fix\/main-red-/i.test(pr?.headRefName ?? "")) return true;
  return /^fix(\([^)]*\))?!?:[ \t]*main red\b/i.test(
    String(pr?.title ?? "").trim()
  );
}

/**
 * Why a PR goes to the FRONT of the queue, or null: "main-red fix" or
 * "revert" (only while main is red), "security fix" (the `security` label,
 * at any time). `mainRed` is true only when main is KNOWN red.
 */
export function jumpReason(pr, { mainRed = false } = {}) {
  const labels = (pr?.labels?.nodes ?? []).map((l) =>
    String(l?.name ?? "").toLowerCase()
  );
  if (labels.includes("security")) return "security fix";
  if (!mainRed) return null;
  if (isMainRedFix(pr)) return "main-red fix";
  if (/^Revert "/.test(String(pr?.title ?? "").trim())) return "revert";
  return null;
}

export function isDependabot(pr) {
  const login = String(pr?.author?.login ?? "").toLowerCase();
  return (
    login === "dependabot" ||
    login === "dependabot[bot]" ||
    /^dependabot\//.test(pr?.headRefName ?? "")
  );
}

/** The gates every action of the bot shares: open, base main, not a draft, not negctl, not a fork. */
export function prGates(pr) {
  const r = [];
  if (pr.state && pr.state !== "OPEN") r.push(`state: ${pr.state}`);
  if (pr.baseRefName !== "main") r.push(`base: ${pr.baseRefName}, not main`);
  if (pr.isDraft) r.push("draft");
  if (/^negctl\//.test(pr.headRefName ?? "")) r.push("negctl branch");
  if (pr.isCrossRepository) r.push("from a fork");
  return r;
}

/**
 * The required checks on one head sha. `checkRuns` = the check runs GitHub
 * returns for that commit; only GitHub Actions' (app 15368) count, the latest
 * of each name. Returns { ok, missing: [name], notGreen: ["name: state"] }.
 */
export function requiredChecksState(
  checkRuns,
  headSha,
  names = REQUIRED_CHECKS
) {
  const latest = new Map();
  const order = (x) =>
    `${x.started_at ?? ""}|${String(x.id).padStart(20, "0")}`;
  for (const c of checkRuns ?? []) {
    if (c?.app?.id !== GITHUB_ACTIONS_APP_ID) continue;
    if (headSha && c.head_sha && c.head_sha !== headSha) continue;
    if (!names.includes(c.name)) continue;
    const prev = latest.get(c.name);
    if (!prev || order(c) > order(prev)) latest.set(c.name, c);
  }
  const missing = [];
  const notGreen = [];
  for (const name of names) {
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
 * A PR the merge queue took out on a red ("failed_checks") is held once the
 * queue has failed it MAX_QUEUE_FAILURES_PER_HEAD times at its current head:
 * its own checks stay green, so without this the bot enqueued the same head
 * again after every red. 29 Oct 2026: #310 was enqueued at an unchanged head
 * three times (20:15, 20:35, 20:58Z) on a real type error, and each red
 * restarted the builds behind it. One failure is retried (an infrastructure
 * flake, like #310's at 20:15); a push resets the count.
 */
export const MAX_QUEUE_FAILURES_PER_HEAD = 2;

/** When the head's CI began: the earliest GitHub Actions check run on it, or null. Pure. */
export function headCiSince(checkRuns, headSha) {
  let since = null;
  for (const c of checkRuns ?? []) {
    if (c?.app?.id !== GITHUB_ACTIONS_APP_ID) continue;
    if (headSha && c.head_sha && c.head_sha !== headSha) continue;
    const t = Date.parse(c.started_at ?? "");
    if (Number.isFinite(t) && (since === null || t < since)) since = t;
  }
  return since;
}

/** The queue's red removals of a PR since `since` (ms), from its GraphQL timeline. Pure. */
export function queueFailuresSince(pr, since) {
  if (since === null) return 0;
  return (pr?.timelineItems?.nodes ?? []).filter(
    (e) =>
      e?.reason === "failed_checks" && Date.parse(e.createdAt ?? "") > since
  ).length;
}

/**
 * One Depends-On state from the resolver's results (layout.mjs evaluateAll).
 * A waiting dependency on a PR of `repo` that is in `queued` (Map of PR number
 * -> head sha) RIDES (hold.mjs rideTheQueue, the one copy of the rule).
 * Returns { state: "landed" | "rides" | "waiting" | "blocked", behind: [n] }.
 */
export function dependsState(results, { repo, queued }) {
  const ridden = rideTheQueue(results ?? [], { repo, queued });
  const behind = ridden.filter((r) => r.rides).map((r) => r.dep.number);
  const v = verdictOf(ridden);
  return { state: v === "landed" && behind.length ? "rides" : v, behind };
}

/**
 * Why a PR is NOT enqueued (empty = enqueue). Pure. `pr` is the GraphQL
 * PullRequest shape read by listOpenPrs. `checks` (requiredChecksState),
 * `depends` (dependsState) and `files` (REST pulls/<n>/files) are judged only
 * when given: the driver reads them for the PRs that pass the cheap gates.
 * `riding`: "Dependencies merged" is required (C). `mainRed`: "red" | "green"
 * | "unknown". `whileRed`: the founder's override of the red-main default.
 */
export function enqueueReasons({
  pr,
  checks,
  depends,
  files,
  riding = false,
  mainRed = "green",
  whileRed = false,
  queueFailures = 0,
}) {
  const r = prGates(pr);
  if (isDependabot(pr)) r.push("dependabot");
  if (!podSessionFromBody(pr.body)) r.push("no `Pod session: <uuid>` line");
  if (pr.mergeable === "CONFLICTING") r.push("conflicting");
  if (pr.isInMergeQueue) r.push("already queued");
  if (queueFailures >= MAX_QUEUE_FAILURES_PER_HEAD)
    r.push(
      `the merge queue failed it ${queueFailures} times at this head: push a fix (a new head is enqueued again)`
    );
  if (
    mainRed !== "green" &&
    !whileRed &&
    !jumpReason(pr, { mainRed: mainRed === "red" })
  )
    r.push(
      mainRed === "red"
        ? "main is red: only main-red fixes, reverts and security fixes are enqueued"
        : "main's state is unknown: only security fixes are enqueued"
    );
  if (depends && depends.state === "rides" && !riding)
    r.push(
      `Depends-On: #${depends.behind.join(", #")} is in the merge queue, but riding is off ("${HOLD_CHECK}" is not a required check, so nothing would hold this PR if it left the queue)`
    );
  else if (depends && depends.state !== "landed" && depends.state !== "rides")
    r.push(`Depends-On: ${depends.state}`);
  if (checks !== undefined && !checks.ok)
    r.push(
      `required checks: ${[...checks.missing.map((n) => `${n}: none`), ...checks.notGreen].join(", ")}`
    );
  if (files !== undefined) {
    const infra = files === null ? null : infraFilesOf(files);
    if (infra === null) r.push("its files could not be read");
    else if (infra.length)
      r.push(
        `${INFRA_REASON} (${infra.slice(0, 3).join(", ")}${infra.length > 3 ? ", …" : ""})`
      );
  }
  return r;
}

/**
 * The enqueue verdict once every input is read. Pure.
 * @returns {{ enqueue: boolean, jump: boolean, jumpReason: string | null,
 *             rides: number[], reasons: string[] }}
 */
export function enqueueDecision(input) {
  const reasons = enqueueReasons(input);
  if (input.checks === undefined) reasons.push("required checks: not read");
  if (input.depends === undefined) reasons.push("Depends-On: not read");
  if (input.files === undefined) reasons.push("files: not read");
  const rides = input.depends?.behind ?? [];
  // A PR riding behind its dependency never jumps ahead of it.
  const why = rides.length
    ? null
    : jumpReason(input.pr, { mainRed: input.mainRed === "red" });
  return {
    enqueue: reasons.length === 0,
    jump: Boolean(why),
    jumpReason: why,
    rides,
    reasons,
  };
}

const at = (x) => Date.parse(x ?? "") || 0;

/** CI push runs on main that finished green or red, newest first. */
function finishedMainRuns(runs) {
  return (runs ?? [])
    .filter(
      (r) =>
        r.event === "push" &&
        r.head_branch === "main" &&
        r.status === "completed" &&
        (r.conclusion === "success" || r.conclusion === "failure")
    )
    .sort((a, b) => at(b.created_at) - at(a.created_at));
}

/** Main's state from its CI push runs: "red" | "green" | "unknown" (no finished run). */
export function mainState(runs) {
  const latest = finishedMainRuns(runs)[0];
  if (!latest) return "unknown";
  return latest.conclusion === "failure" ? "red" : "green";
}

/**
 * Main's latest red→green transition of the last WINDOW_MAX_AGE_HOURS, or
 * null. `runs` = CI push runs on main (any order, any status); only finished
 * runs that succeeded or failed count (a cancelled or skipped run says nothing
 * about main). Null while main is red again (a fresh run would test a red
 * main), when no transition is in the list, or when it is older.
 * Window: [the first red run's created_at (the red push), the green run's end].
 */
export function mainRedWindow(
  runs,
  { now = Date.now(), maxAgeHours = WINDOW_MAX_AGE_HOURS } = {}
) {
  const done = finishedMainRuns(runs);
  if (!done.length || done[0].conclusion !== "success") return null;
  const g = done.findIndex(
    (r, i) =>
      r.conclusion === "success" && done[i + 1]?.conclusion === "failure"
  );
  if (g < 0) return null;
  const green = done[g];
  const streak = [];
  for (const r of done.slice(g + 1)) {
    if (r.conclusion !== "failure") break;
    streak.push(r);
  }
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
  const r = prGates(pr);
  if (!window) r.unshift("main is not just back to green");
  // A draft toggle takes a queued PR out of the queue.
  if (pr.isInMergeQueue) r.push("in the merge queue");
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

/** An enqueue refused because the PR is already queued (a concurrent pass got there first). */
export const ALREADY_QUEUED =
  /already (in the merge queue|queued|enqueued)|is already in (a|the) merge queue/i;

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
        labels(first: 20) { nodes { name } }
        timelineItems(last: 20, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
          nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } }
        }
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

/** A PR's changed files (REST, 100 a page, GitHub's 3000-file cap), or null when they cannot all be read. */
export function listPrFiles(gh, repo, number, token) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    let batch;
    try {
      batch = gh.rest(
        `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
        { token }
      );
    } catch {
      return null;
    }
    if (!Array.isArray(batch)) return null;
    files.push(...batch);
    if (batch.length < 100) return files;
  }
  return null; // more than 3000 files: not all of them are visible
}

/**
 * The required checks of `main`, read live from its rules (the ruleset), or
 * null when they cannot be read (then: REQUIRED_CHECKS, and no riding).
 */
export function liveRequiredChecks(gh, repo, token) {
  try {
    return requiredContextsOf(
      gh.rest(`repos/${repo}/rules/branches/main?per_page=100`, { token })
    );
  } catch {
    return null;
  }
}

/** The Depends-On results of a PR body, through the layout resolver. */
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
    return evaluateAll(parsed, client, {
      defaultBranch: layout.defaultBranch,
    });
  };
}

// ── driver ──────────────────────────────────────────────────────────────────

/**
 * One pass. Returns { code, enqueued: [n], rerun: [n], failures }.
 * `dependsOf(pr, repo)` → the resolver's results (default: layout).
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
  const whileRed = env.MERGE_BOT_ENQUEUE_WHILE_RED === "true";
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
  // The queue as the PR list saw it; a PR enqueued in this pass joins it.
  const queued = new Map(
    prs.filter((p) => p.isInMergeQueue).map((p) => [p.number, p.headRefOid])
  );
  const live = liveRequiredChecks(gh, repo, readToken);
  const names = [...new Set([...REQUIRED_CHECKS, ...(live ?? [])])];
  const riding = Boolean(live?.includes(HOLD_CHECK));
  log(
    live
      ? `required checks: ${names.join(", ")}; dependents ${riding ? "ride their queued dependency" : `wait for their dependency to merge ("${HOLD_CHECK}" is not required)`}`
      : `::warning::could not read main's required checks: using ${names.join(", ")}; dependents wait for their dependency to merge`
  );
  let mainRuns = null;
  try {
    mainRuns =
      gh.rest(
        `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&event=push&per_page=50`,
        { token: readToken }
      )?.workflow_runs ?? [];
  } catch (e) {
    log(`::warning::could not read main's CI runs (${e.message})`);
  }
  const mainRed = mainRuns ? mainState(mainRuns) : "unknown";
  log(
    `main is ${mainRed}${mainRed === "green" ? "" : whileRed ? ": MERGE_BOT_ENQUEUE_WHILE_RED=true, every eligible PR is enqueued" : ": only PRs that jump are enqueued"}`
  );
  if (prMode) prs = prs.filter((p) => p.headRefOid === wr.head_sha);
  log(
    `${prMode ? `CI run ${wr.id} of ${String(wr.head_sha).slice(0, 9)}` : `sweep (${event})`}: ${prs.length} open PR(s)`
  );

  if (!prMode && mainRuns)
    await victims({
      gh,
      repo,
      prs,
      readToken,
      botToken,
      dryRun,
      log,
      window: mainRedWindow(mainRuns, { now }),
      out,
    });

  // A + B + C: the jumpers first, then the oldest first.
  const jumps = (p) => Boolean(jumpReason(p, { mainRed: mainRed === "red" }));
  const ordered = [...prs].sort((a, b) => Number(jumps(b)) - Number(jumps(a)));
  const ctx = { riding, mainRed, whileRed };
  for (const pr of ordered) {
    const tag = `#${pr.number}`;
    const cheap = enqueueReasons({ pr, ...ctx });
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
      const checks = requiredChecksState(
        runs?.check_runs,
        pr.headRefOid,
        names
      );
      const queueFailures = queueFailuresSince(
        pr,
        headCiSince(runs?.check_runs, pr.headRefOid)
      );
      // Depends-On and the files are read only for a PR whose checks are green.
      if (checks.ok) {
        const dep = dependsState(await depends(pr, repo), { repo, queued });
        const files = listPrFiles(gh, repo, pr.number, readToken);
        d = enqueueDecision({
          pr,
          checks,
          depends: dep,
          files,
          queueFailures,
          ...ctx,
        });
      } else
        d = {
          enqueue: false,
          reasons: enqueueReasons({ pr, checks, queueFailures, ...ctx }),
        };
    } catch (e) {
      log(`${tag} not enqueued: a read failed (${e.message})`);
      continue;
    }
    if (!d.enqueue) {
      log(`${tag} not enqueued: ${d.reasons.join("; ")}`);
      continue;
    }
    const how = d.jump
      ? ` with jump (${d.jumpReason})`
      : d.rides.length
        ? ` behind #${d.rides.join(", #")} (rides with its dependency)`
        : "";
    if (dryRun) {
      log(`${tag} WOULD enqueue${how} at ${pr.headRefOid.slice(0, 9)}`);
      continue;
    }
    if (enqueue(gh, pr, d.jump, botToken, log, how)) {
      out.enqueued.push(pr.number);
      queued.set(pr.number, pr.headRefOid);
    } else out.failures++;
  }
  log(
    `done: ${out.enqueued.length} enqueued${out.enqueued.length ? ` (#${out.enqueued.join(", #")})` : ""}, ${out.rerun.length} run again${out.rerun.length ? ` (#${out.rerun.join(", #")})` : ""}, ${out.failures} write(s) failed`
  );
  out.code = out.failures ? 1 : 0;
  return out;
}

/**
 * Enqueue one PR with the bot's token: with the jump, then (if GitHub refuses
 * it) without. "Already queued" (a concurrent pass got there first) counts as
 * entered. True when it entered.
 */
function enqueue(gh, pr, jump, token, log, how = "") {
  const tag = `#${pr.number}`;
  let last;
  for (const j of jump ? [true, false] : [false]) {
    try {
      const res = gh.graphql(
        ENQUEUE,
        { id: pr.id, oid: pr.headRefOid, jump: j },
        { token }
      );
      const e = res?.data?.enqueuePullRequest?.mergeQueueEntry;
      log(
        `${tag} enqueued${j || !jump ? how : " (no jump)"}: position ${e?.position ?? "?"}, ${e?.state ?? "?"}`
      );
      return true;
    } catch (e) {
      if (ALREADY_QUEUED.test(e.message)) {
        log(`${tag} was already queued (${e.message})`);
        return true;
      }
      last = e;
      if (j)
        log(
          `::warning::${tag} could not jump the queue (${e.message}); enqueuing it without the jump`
        );
    }
  }
  log(`::warning::${tag} could not be enqueued: ${last.message}`);
  return false;
}

async function victims({
  gh,
  repo,
  prs,
  readToken,
  botToken,
  dryRun,
  log,
  window,
  out,
}) {
  if (!window) {
    log("main: no red→green transition to answer");
    return;
  }
  log(
    `main went green in run ${window.green.id} after ${window.firstRed.id === window.lastRed.id ? `red run ${window.lastRed.id}` : `red runs ${window.firstRed.id}…${window.lastRed.id}`}: window ${window.start} → ${window.end}`
  );
  let mainSha;
  let toggled = 0;
  for (const pr of prs) {
    const tag = `#${pr.number}`;
    if (victimReasons({ pr, window }).length) continue;
    if (toggled >= MAX_TOGGLES_PER_SWEEP) {
      log(
        `${tag} and later victims wait for the next sweep (at most ${MAX_TOGGLES_PER_SWEEP} per sweep)`
      );
      break;
    }
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
      toggled++;
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
