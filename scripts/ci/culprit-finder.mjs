#!/usr/bin/env node
/**
 * culprit-finder.mjs: name the PR that made backend main red, and revert it
 * when nobody fixes it (founder decision 0b4db9f7, 2026-10-29 ~13:10Z:
 * "When backend main goes red, name the culprit PR and post to its pod
 * session; after 30 min with no fix from that session, the bot opens a
 * revert PR and it jumps the merge queue").
 * ===========================================================================
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * A PR runs only the tests of what it can break; main's post-merge run is the
 * first to run everything (ci.yml, "One trunk, three CI tiers"). On 29 Oct
 * five PRs merged at 01:00Z, run 40797830929 went red at 01:46Z, and main
 * stayed red until #489 landed at 09:54Z: ~9 h, 33 PR runs with 0 green. The
 * culprits (#467: a lint error in its own test file; #476: three test files
 * that read the inbound tables it added) were knowable at 01:46Z.
 * Prior art (pod document cd1bf4e9, Google TAP and Build Cop): "the most
 * effective tool the Build Cop has is the rollback".
 *
 * ── THREE MODES ──────────────────────────────────────────────────────────────
 * name    on a red push run of CI on main (.github/workflows/red-main.yml,
 *         workflow_run). Reads the FAILING FILES of the run's failed jobs
 *         (failingFiles: the test ratchet's [new-failure] / [fixed] /
 *         [stale-baseline] lists, eslint and prettier files, tsc errors), the
 *         first-parent commits since the last all-green main
 *         (release-gate-wait.mjs culpritRange), and each commit's PR and its
 *         changed files. Then attribute(), cheapest correct method first:
 *           1. the range holds ONE commit → it is the culprit (high);
 *           2. exactly one PR of the range changed the failing file (high);
 *           3. exactly one PR can REACH the file through the affected graph
 *              (scripts/ci/affected.mjs: its packages, their dependents, the
 *              test files that read them by path; a tripwire is reached by
 *              every PR, since it reads across the tree) (medium);
 *           4. otherwise ambiguous.
 *         Every failing file a test, lint or type check can re-run that is not
 *         `high` goes to `bisect` (one job). If none does, it records and
 *         posts the verdict at once.
 * bisect  ONE job (installs once): re-runs ONLY the unresolved failing files
 *         at chosen commits of the range, a binary search per file over the
 *         first-parent line (lastGreen passes, the red commit fails), every
 *         probe running every unresolved file so files share probes; at most
 *         MAX_PROBES probes. A file that passes alone at the red commit is
 *         `low` ("did not fail when run alone"), never a culprit.
 * sweep   every 10 min. Reverts at most ONE culprit per red, only when
 *         revertDecision() says so (THE REVERT RULE below).
 *
 * A verdict is posted three ways: a comment on each culprit PR (once per
 * culprit merge: a hidden marker carries the files and the time it was
 * first named), a message in the culprit's pod session room (the
 * `Pod session:` line of its body) when the pod is configured, and a
 * check run RECORD_CHECK on the red commit whose text holds the record as
 * JSON (what `sweep` reads). Not a required check.
 *
 * ── THE REVERT RULE (revertDecision) ─────────────────────────────────────────
 * The sweep opens a revert PR only when ALL hold:
 *   - main's newest finished push run is red, no newer push run is still
 *     running (it may be the fix), and that run has a record;
 *   - the record names exactly ONE culprit, a merged PR, at confidence
 *     `high`, and every failing file of the run is attributed to it (a revert
 *     that cannot green main is not revert-first: with two culprits, or a
 *     file nothing explains, it posts and a person decides);
 *   - the culprit is not itself a revert (title `Revert …` or a
 *     `fix/main-red-revert-*` branch): never revert a revert;
 *   - it was first named GRACE_MINUTES (30) ago or more, and the files it
 *     was named for still fail (the same red, not a new one);
 *   - NOBODY OWNS THE FIX (the one-owner rule, .claude/rules/github-ci.md
 *     "Never pile onto a red main"): no open PR on a `fix/main-red-*` branch;
 *     no open PR whose body names the culprit's pod session and that was
 *     opened after the culprit merged; and the pod lists no ACTIVE session
 *     titled `main red: backend …` started after the culprit merged. A pod
 *     that is not configured or cannot be read is an UNKNOWN owner, and an
 *     unknown owner holds the revert (a failed read is never "nobody");
 *   - this red has had no revert PR yet (any state: a closed one is a person
 *     saying no), and the revert branch does not exist;
 *   - the bot's app token is present (secrets SYNAP_MERGE_BOT_APP_ID /
 *     SYNAP_MERGE_BOT_KEY, the "Synap Merge Bot" app of merge-bot.yml).
 *     Without it: log what it would do, exit 0.
 * GRACE AND AN OWNER: the window starts when the culprit is first named. An
 * owner who shows up (a `main red: backend` session, a `fix/main-red-*` PR,
 * a PR from the culprit's session) holds the revert for as long as it is
 * open, with no deadline: the bot says so once on the culprit PR and never
 * fights it. When the owner closes without main going green, the next sweep
 * reverts (the window has passed).
 *
 * The revert: `git revert -m 1 <merge sha>` (no -m for a one-parent commit)
 * on `origin/main`, pushed as `fix/main-red-revert-<pr>-<sha8>` (the merge
 * bot's `fix/main-red-*` rule puts it at the front of the queue), and a READY
 * PR whose body carries the culprit, the evidence, the failing files, the
 * culprit's `Pod session:` line and "Revert-first: founder decision
 * 0b4db9f7". A conflict aborts the revert and says so once. It never pushes
 * to main, never merges, never enqueues (the merge bot does).
 *
 * Env: GITHUB_REPOSITORY, GH_TOKEN (reads; issues/checks writes), RUN_ID
 * (name), PLAN / PLAN_FILE (bisect), REVERT_TOKEN (sweep: the app token),
 * SYNAP_POD_URL + SYNAP_OBS_KEY (a pod Hub key with hub-protocol.read and
 * .write) + SYNAP_POD_WORKSPACE_ID (the space whose sessions are listed for
 * an owner), CULPRIT_DRY_RUN=true (judge and log, write nothing).
 * Transport: the `gh` CLI and global fetch, injected, so the tripwire drives
 * it with fakes. Node built-ins only (the name and sweep jobs do not install).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TEST_FILE,
  loadGraph,
  packageOf,
  selectTier,
  workspacePackages,
} from "./affected.mjs";
import {
  CI_WORKFLOW,
  culpritRange,
  decide,
  githubReader,
} from "./release-gate-wait.mjs";
import { isTripwire } from "../tripwire-discovery.mjs";

/** The founder decision this automates (pod decision entity). */
export const FOUNDER_DECISION = "0b4db9f7";
/** Minutes between naming a culprit and reverting it. */
export const GRACE_MINUTES = 30;
/** The check run that carries a red commit's record (not a required check). */
export const RECORD_CHECK = "Red main: culprit";
/** A revert branch: the merge bot's `fix/main-red-*` rule makes it jump. */
export const REVERT_BRANCH_RE = /^fix\/main-red-revert-(\d+)-([0-9a-f]{8})$/;
/** A branch that fixes main red (an owner at work), revert branches included. */
export const FIX_BRANCH_RE = /^fix\/main-red-/i;
/** The one owner of a red main (.claude/rules/github-ci.md). */
export const OWNER_TITLE_RE = /^\s*main red:\s*backend\b/i;
/** At most this many probes (checkouts) in one bisect job. */
export const MAX_PROBES = 8;
/** First-parent commits looked at for the last all-green main. */
export const RANGE_LIMIT = 30;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Same rule as POD_SESSION_LINE_RE (packages/types dev-loop.ts, pod-observation.mjs). */
export const POD_SESSION_LINE_RE = new RegExp(
  `^\\W*pod session\\W*:?\\s*\\W*(${UUID})`,
  "im"
);
const MARK = "red-main-culprit";
const HELD_MARK = "red-main-held";
const CONFLICT_MARK = "red-main-revert-conflict";
/** The revert PR body line that ties it to one red (its last green main). */
const RED_BASE_LINE = "Red-main-base:";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ── pure: reading the run ───────────────────────────────────────────────────

/** The `Pod session:` id of a PR body, or null. */
export function podSessionOf(body) {
  const m = POD_SESSION_LINE_RE.exec(String(body ?? ""));
  return m ? m[1].toLowerCase() : null;
}

/** The PR number of a GitHub merge commit subject, or null. */
export function prOfSubject(subject) {
  const m = /^Merge pull request #(\d+) from /.exec(String(subject ?? ""));
  return m ? Number(m[1]) : null;
}

/** A job log line without the runner's timestamp (and BOM). */
const strip = (line) =>
  line.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\r$/, "");

const RATCHET_KIND = {
  "new-failure": "test",
  fixed: "fixed",
  "stale-baseline": "stale",
};

/**
 * The failing files a job log names: [{ file, kind }], kind
 *   test   the test ratchet's [new-failure] list (failed twice where retried)
 *   fixed  a baseline file that now passes ([fixed]: the red is the baseline)
 *   stale  a baseline file that did not run ([stale-baseline])
 *   lint   an eslint file with an `error`, or a prettier `[warn]` file
 *   type   a file with a `error TS` (repo-relative; a turbo `pkg:task:` prefix
 *          resolves a package-relative path through `dirsByName`)
 * Only what the log NAMES; a red job that names no file adds nothing.
 */
export function failingFiles(log, { dirsByName = new Map() } = {}) {
  const out = new Map();
  const add = (file, kind) => {
    if (!file || out.has(file)) return;
    out.set(file, kind);
  };
  let section = null;
  let eslintFile = null;
  for (const raw of String(log ?? "").split("\n")) {
    const line = strip(raw).replace(/^##\[(error|warning)\]/, "");
    const header = /^\s*\[([a-z-]+)\]\s*$/.exec(line);
    if (header) {
      section = RATCHET_KIND[header[1]] ?? null;
      continue;
    }
    if (section) {
      const m =
        /^ {6}([A-Za-z0-9_.@/-]+\/[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+)$/.exec(line);
      if (m) {
        add(m[1], section);
        continue;
      }
    }
    const abs =
      /^\/home\/runner\/work\/[^/]+\/[^/]+\/(\S+\.[A-Za-z0-9]+)$/.exec(line);
    if (abs) {
      eslintFile = abs[1];
      continue;
    }
    if (eslintFile) {
      if (/^\s+\d+:\d+\s+error\s/.test(line)) {
        add(eslintFile, "lint");
        eslintFile = null;
      } else if (!/^\s+\d+:\d+\s/.test(line)) eslintFile = null;
    }
    const warn = /^\[warn\] ([A-Za-z0-9_.@/-]+\.[A-Za-z0-9]+)$/.exec(line);
    if (warn) add(warn[1], "lint");
    const ts =
      /^(?:(@?[A-Za-z0-9_./-]+):[A-Za-z0-9_:-]+: )?(\S+\.(?:ts|tsx|mts|cts))\(\d+,\d+\): error TS\d+/.exec(
        line
      );
    if (ts) {
      let file = ts[2];
      const dir = ts[1] ? dirsByName.get(ts[1]) : null;
      if (dir && !file.startsWith(`${dir}/`)) file = `${dir}/${file}`;
      add(file, "type");
    }
  }
  return [...out].map(([file, kind]) => ({ file, kind }));
}

// ── pure: who did it ────────────────────────────────────────────────────────

/** Paths no test reads: docs (not reference/decisions/architecture), root *.md. */
const neutralPath = (f) =>
  /^docs\/(?!reference\/|decisions\/|architecture\/)/.test(f) ||
  /^[^/]+\.md$/.test(f);

/**
 * May a change of `prFiles` make `file` fail? Through the affected graph
 * (selectTier): the full suite reaches everything; otherwise its packages,
 * their dependents and the test files that read them. A tripwire reads across
 * the tree, so every change reaches it.
 */
export function reaches(prFiles, file, { graph, refs, isTripwire }) {
  const files = (prFiles ?? []).filter((f) => !neutralPath(f));
  if (files.length === 0) return false;
  if (isTripwire?.(file)) return true;
  const t = selectTier(files, { graph, refs });
  if (t.scope === "full") return true;
  const dirs = [...graph.keys()];
  const pkg = packageOf(file, dirs);
  return (pkg != null && t.dirs.includes(pkg)) || t.tests.includes(file);
}

/** Kinds a probe can re-run at another commit. */
export const BISECTABLE = new Set(["test", "lint", "type"]);

/**
 * Per failing file, which candidate commit made it fail, by the cheapest
 * correct method. `candidates` oldest first: [{ sha, pr, files }] (files =
 * the PR's changed paths, null when unread). Returns Map file →
 *   { method: "range"|"direct"|"reach"|"ambiguous"|"none",
 *     confidence: "high"|"medium"|"low", shas: [candidate shas] }
 */
export function attribute(failing, candidates, deps) {
  const out = new Map();
  for (const { file } of failing) {
    if (candidates.length === 1) {
      out.set(file, {
        method: "range",
        confidence: "high",
        shas: [candidates[0].sha],
      });
      continue;
    }
    const direct = candidates.filter((c) => c.files?.includes(file));
    if (direct.length === 1) {
      out.set(file, {
        method: "direct",
        confidence: "high",
        shas: [direct[0].sha],
      });
      continue;
    }
    if (direct.length > 1) {
      out.set(file, {
        method: "ambiguous",
        confidence: "low",
        shas: direct.map((c) => c.sha),
      });
      continue;
    }
    // A PR whose files are unread reaches everything: never a false "only one".
    const reach = candidates.filter(
      (c) => c.files == null || reaches(c.files, file, deps)
    );
    if (reach.length === 1)
      out.set(file, {
        method: "reach",
        confidence: "medium",
        shas: [reach[0].sha],
      });
    else
      out.set(file, {
        method: reach.length ? "ambiguous" : "none",
        confidence: "low",
        shas: reach.map((c) => c.sha),
      });
  }
  return out;
}

/** The files that need a probe: re-runnable and not already `high`. */
export function needsBisect(failing, attribution) {
  return failing.filter(
    (f) =>
      BISECTABLE.has(f.kind) && attribution.get(f.file)?.confidence !== "high"
  );
}

/**
 * Binary search per file over `shas` (oldest first; the commit before
 * shas[0] is the last all-green main, taken as passing). `probe(sha, files)`
 * runs `files` at `sha` and returns Map file → "pass"|"fail"|"absent"|"error".
 * Every probe runs every file not yet known at that commit, so files share
 * probes. The red commit (last sha) is probed first: a file that passes there
 * alone does not reproduce. Returns { results: Map file → { sha|null,
 * confidence, why }, probes }.
 */
export async function bisect(
  shas,
  files,
  probe,
  { maxProbes = MAX_PROBES } = {}
) {
  const seen = new Map(); // sha → Map(file → result)
  let probes = 0;
  const result = async (sha, file) => {
    const known = seen.get(sha);
    if (known?.has(file)) return known.get(file);
    if (probes >= maxProbes) return "budget";
    probes++;
    const want = files.filter((f) => !known?.has(f));
    const got = await probe(sha, want);
    const m = known ?? new Map();
    for (const f of want) m.set(f, got.get(f) ?? "error");
    seen.set(sha, m);
    return m.get(file);
  };
  const results = new Map();
  for (const file of files) {
    const tip = shas.length - 1;
    const atTip = await result(shas[tip], file);
    if (atTip !== "fail") {
      results.set(file, {
        sha: null,
        confidence: "low",
        why:
          atTip === "budget"
            ? `not probed: the bisect used its ${maxProbes} probes`
            : `did not fail when run alone at the red commit (${atTip})`,
      });
      continue;
    }
    let lo = -1; // passes (the last all-green main, or a probed pass)
    let hi = tip; // fails
    let stuck = null;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await result(shas[mid], file);
      if (r === "fail") hi = mid;
      else if (r === "pass" || r === "absent") lo = mid;
      else {
        stuck = r;
        break;
      }
    }
    results.set(
      file,
      stuck
        ? {
            sha: null,
            confidence: "low",
            why:
              stuck === "budget"
                ? `narrowed to ${shas
                    .slice(lo + 1, hi + 1)
                    .map((s) => s.slice(0, 9))
                    .join(", ")}: the bisect used its ${maxProbes} probes`
                : `a probe could not run the file (${stuck})`,
          }
        : {
            sha: shas[hi],
            confidence: "high",
            why:
              lo === -1
                ? `fails at ${shas[hi].slice(0, 9)}, passed at the last all-green main`
                : `fails at ${shas[hi].slice(0, 9)}, passes at ${shas[lo].slice(0, 9)} (its first parent on main)`,
          }
    );
  }
  return { results, probes };
}

/**
 * The verdict: culprits grouped by PR. `attribution` = attribute(); `bisected`
 * = bisect().results (or null). Returns { culprits: [{ sha, pr, confidence,
 * files: [{file, kind, confidence, why}] }], unattributed: [{file, kind, why}],
 * revertable: bool, why: [strings] }.
 */
export function verdict({ failing, candidates, attribution, bisected = null }) {
  const bySha = new Map(candidates.map((c) => [c.sha, c]));
  const groups = new Map();
  const unattributed = [];
  const RANK = { high: 3, medium: 2, low: 1 };
  for (const f of failing) {
    const a = attribution.get(f.file);
    const b = bisected?.get(f.file);
    let sha = null;
    let confidence = "low";
    let why = "";
    if (a?.confidence === "high") {
      sha = a.shas[0];
      confidence = "high";
      why =
        a.method === "range"
          ? "the only commit since the last all-green main"
          : "the only PR in the range that changed this file";
    } else if (b?.sha) {
      sha = b.sha;
      confidence = b.confidence;
      why = `bisect: ${b.why}`;
    } else if (a?.confidence === "medium") {
      sha = a.shas[0];
      confidence = "medium";
      why = `the only PR in the range that can reach this file (affected graph)${b ? `; bisect: ${b.why}` : ""}`;
    } else {
      unattributed.push({
        file: f.file,
        kind: f.kind,
        why:
          (b
            ? `bisect: ${b.why}`
            : a?.method === "none"
              ? "no PR in the range can reach it (a flake or the environment?)"
              : `${a?.shas.length ?? 0} PRs in the range can reach it`) +
          (BISECTABLE.has(f.kind) ? "" : `; a ${f.kind} red cannot be re-run`),
      });
      continue;
    }
    const g = groups.get(sha) ?? {
      sha,
      pr: bySha.get(sha)?.pr ?? null,
      confidence: "low",
      files: [],
    };
    g.files.push({ file: f.file, kind: f.kind, confidence, why });
    if (RANK[confidence] > RANK[g.confidence]) g.confidence = confidence;
    groups.set(sha, g);
  }
  const culprits = [...groups.values()];
  const why = [];
  if (failing.length === 0) why.push("the red run names no failing file");
  if (culprits.length !== 1)
    why.push(`${culprits.length} culprits (a revert needs exactly one)`);
  const only = culprits.length === 1 ? culprits[0] : null;
  if (only && only.confidence !== "high")
    why.push(
      `the culprit is ${only.confidence} confidence (a revert needs high)`
    );
  if (only && only.pr == null) why.push("the culprit commit is not a PR merge");
  if (unattributed.length)
    why.push(`${unattributed.length} failing file(s) no culprit explains`);
  return { culprits, unattributed, revertable: why.length === 0, why };
}

// ── pure: the revert rule ───────────────────────────────────────────────────

const at = (iso) => (iso ? Date.parse(iso) : NaN);

/** Is this PR itself a revert? Then it is never reverted. */
export function isRevert(pr) {
  return (
    REVERT_BRANCH_RE.test(pr?.head ?? "") || /^Revert\b/i.test(pr?.title ?? "")
  );
}

/** The revert branch for a culprit. */
export const revertBranch = (pr, sha) =>
  `fix/main-red-revert-${pr}-${String(sha).slice(0, 8)}`;

/**
 * May the sweep revert now? Pure. Input:
 *   now            ms
 *   main           { latest: run|null, newerRunning: bool }  (main's push runs)
 *   record         the latest red run's record, or null
 *   culpritPr      { number, title, head, mergedAt, session } of record's culprit
 *   openPrs        [{ number, head, body, createdAt }]
 *   revertPrs      [{ number, head, body, state }] PRs on revert branches (any state)
 *   branchExists   bool (the revert branch)
 *   owners         { ok: true, sessions: [{ title, status, startedAt }] } | { ok: false, why }
 *   token          bool (the app token is present)
 * Returns { revert: bool, hold: string|null (an owner is working), reasons }.
 */
export function revertDecision(input) {
  const r = [];
  const { now, main, record, culpritPr } = input;
  if (!main?.latest)
    return {
      revert: false,
      hold: null,
      reasons: ["no finished push run on main"],
    };
  if (main.latest.conclusion === "success")
    return { revert: false, hold: null, reasons: ["main is green"] };
  if (main.newerRunning)
    return {
      revert: false,
      hold: null,
      reasons: ["a newer main run is still running (it may be the fix)"],
    };
  if (!record)
    return {
      revert: false,
      hold: null,
      reasons: ["the red run has no culprit record yet"],
    };
  if (!record.revertable)
    return {
      revert: false,
      hold: null,
      reasons: [
        `not revertable: ${(record.why ?? []).join("; ") || "no reason recorded"}`,
      ],
    };
  const c = record.culprits?.[0];
  if (!c || !culpritPr)
    return {
      revert: false,
      hold: null,
      reasons: ["the culprit PR is not read"],
    };
  if (isRevert(culpritPr))
    return {
      revert: false,
      hold: null,
      reasons: [`#${culpritPr.number} is a revert: never revert a revert`],
    };
  const named = at(c.namedAt);
  if (!Number.isFinite(named)) r.push("the culprit has no naming time");
  else if (now - named < GRACE_MINUTES * 60_000)
    r.push(
      `grace: named ${Math.floor((now - named) / 60_000)} min ago, reverts from ${new Date(named + GRACE_MINUTES * 60_000).toISOString()}`
    );
  const namedFiles = new Set(c.namedFiles ?? []);
  if (!c.files?.some((f) => namedFiles.has(f.file)))
    r.push("the files it was named for no longer fail (a different red)");
  const branch = revertBranch(culpritPr.number, c.sha);
  const priorRevert = (input.revertPrs ?? []).find(
    (p) =>
      REVERT_BRANCH_RE.test(p.head) &&
      String(p.body ?? "").includes(`${RED_BASE_LINE} ${record.lastGreen}`)
  );
  if (priorRevert)
    r.push(
      `this red already had its revert (#${priorRevert.number}, ${priorRevert.state})`
    );
  if (input.branchExists) r.push(`the branch ${branch} exists`);
  // The one owner: a person or a session already fixing it.
  const merged = at(culpritPr.mergedAt);
  let hold = null;
  const fixPr = (input.openPrs ?? []).find(
    (p) => FIX_BRANCH_RE.test(p.head) && p.number !== culpritPr.number
  );
  if (fixPr) hold = `#${fixPr.number} (${fixPr.head}) is open`;
  const fromSession = culpritPr.session
    ? (input.openPrs ?? []).find(
        (p) =>
          p.number !== culpritPr.number &&
          podSessionOf(p.body) === culpritPr.session &&
          !(at(p.createdAt) < merged)
      )
    : null;
  if (!hold && fromSession)
    hold = `#${fromSession.number} from the culprit's pod session is open`;
  if (!hold) {
    if (!input.owners?.ok)
      hold = `the owner is unknown (${input.owners?.why ?? "pod not read"})`;
    else {
      const owner = input.owners.sessions.find(
        (s) =>
          s.status === "active" &&
          OWNER_TITLE_RE.test(s.title ?? "") &&
          !(at(s.startedAt) < merged)
      );
      if (owner) hold = `the pod session "${owner.title}" owns this red`;
    }
  }
  if (hold) r.push(`held: ${hold}`);
  if (!input.token && r.length === 0)
    r.push(
      "no app token (SYNAP_MERGE_BOT_APP_ID / SYNAP_MERGE_BOT_KEY): would revert, logging only"
    );
  return { revert: r.length === 0, hold, reasons: r };
}

// ── text ────────────────────────────────────────────────────────────────────

const short = (s) => String(s ?? "").slice(0, 9);

/** The hidden marker of a culprit comment, and its parse. */
export function culpritMarker(data) {
  return `<!-- ${MARK} ${JSON.stringify(data)} -->`;
}
export function readMarker(body, mark = MARK) {
  const m = new RegExp(`<!-- ${mark} (\\{.*?\\}) -->`).exec(String(body ?? ""));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function fileLines(files) {
  return files.map(
    (f) => `- \`${f.file}\` (${f.kind}, ${f.confidence ?? "?"}): ${f.why}`
  );
}

/** The comment on a culprit PR. */
export function culpritComment({ record, culprit, namedAt, revertable }) {
  const until = new Date(at(namedAt) + GRACE_MINUTES * 60_000).toISOString();
  return [
    culpritMarker({
      merge: culprit.sha,
      red: record.redSha,
      lastGreen: record.lastGreen,
      files: culprit.files.map((f) => f.file),
      namedAt,
    }),
    `### This PR's merge made main red`,
    "",
    `Main's post-merge run ${record.runUrl} of \`${short(record.redSha)}\` is red. The culprit finder (scripts/ci/culprit-finder.mjs) names this PR's merge \`${short(culprit.sha)}\`, confidence **${culprit.confidence}**, for:`,
    "",
    ...fileLines(culprit.files),
    "",
    revertable
      ? `Revert-first (founder decision ${FOUNDER_DECISION}): if main is still red on these files at ${until} and nobody owns the fix, the bot opens \`${revertBranch(culprit.pr, culprit.sha)}\`, a revert of this merge that jumps the merge queue. Nobody owns it while one of these is open: a \`fix/main-red-*\` PR, a PR naming this PR's pod session, an active pod session titled \`main red: backend …\`. To fix forward, open one of them now.`
      : `No automatic revert for this red: ${record.why.join("; ")}. One owner fixes it (.claude/rules/github-ci.md, "Never pile onto a red main").`,
  ].join("\n");
}

/** The pod room message for a culprit's session. */
export function podMessage({ record, culprit, prUrl, revertable }) {
  return [
    `Main is red, and this session's PR ${prUrl} is named as the cause (confidence ${culprit.confidence}).`,
    `Failing: ${culprit.files.map((f) => f.file).join(", ")}.`,
    `Run: ${record.runUrl}.`,
    revertable
      ? `If nobody owns the fix within ${GRACE_MINUTES} min (a fix/main-red-* PR, a PR from this session, or an active "main red: backend" session), the bot opens a revert PR (founder decision ${FOUNDER_DECISION}).`
      : `No automatic revert: ${record.why.join("; ")}.`,
  ].join(" ");
}

/** The record check run's text and its parse. */
export function recordText(record) {
  return `<!-- ${MARK}-record -->\n\`\`\`json\n${JSON.stringify(record, null, 1)}\n\`\`\``;
}
export function readRecord(text) {
  const s = String(text ?? "");
  if (!s.includes(`<!-- ${MARK}-record -->`)) return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** The revert PR body. */
export function revertBody({ record, culprit, culpritPr }) {
  return [
    `Reverts #${culpritPr.number} (merge \`${culprit.sha}\`), named by the culprit finder as the cause of main's red run ${record.runUrl}.`,
    "",
    `Revert-first: founder decision ${FOUNDER_DECISION}. Named at ${culprit.namedAt}; ${GRACE_MINUTES} min later main was still red on the same files and nobody owned the fix (no open \`fix/main-red-*\` PR, no PR from #${culpritPr.number}'s pod session, no active \`main red: backend\` session).`,
    "",
    "Failing files, and why this merge:",
    ...fileLines(culprit.files),
    "",
    `To land the change again: revert this revert in a PR that fixes it.`,
    "",
    `${RED_BASE_LINE} ${record.lastGreen}`,
    ...(culpritPr.session ? [`Pod session: ${culpritPr.session}`] : []),
    "",
    "Opened by .github/workflows/red-main.yml (scripts/ci/culprit-finder.mjs). The merge bot enqueues it with jump once its checks are green.",
  ].join("\n");
}

// ── transport ───────────────────────────────────────────────────────────────

/** `gh api` as JSON. `token` overrides GH_TOKEN for one call. */
export function ghTransport({ ghBin = "gh", env = process.env } = {}) {
  function call(args, { token, input, raw = false } = {}) {
    try {
      const out = execFileSync(ghBin, args, {
        env: { ...env, ...(token ? { GH_TOKEN: token } : {}) },
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
      });
      if (raw) return out;
      return out.trim() ? JSON.parse(out) : null;
    } catch (e) {
      const msg = String(e.stderr || e.message || e).trim();
      throw new Error(`gh ${args.slice(0, 4).join(" ")}: ${msg}`);
    }
  }
  return {
    rest: (path, { token, method = "GET", body, raw } = {}) =>
      call(["api", "-X", method, path, ...(body ? ["--input", "-"] : [])], {
        token,
        input: body ? JSON.stringify(body) : undefined,
        raw,
      }),
  };
}

/** A shell for git and the probes: { code, out }. Never throws. */
export function realShell(
  cmd,
  args,
  { cwd = REPO_ROOT, env = process.env, timeoutMs = 20 * 60_000 } = {}
) {
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`,
  };
}

// ── the pod (Hub REST) ──────────────────────────────────────────────────────

/** The pod door, or null when it is not configured. */
export function podClient(env, fetchImpl = globalThis.fetch) {
  const url = env.SYNAP_POD_URL?.replace(/\/+$/, "");
  const key = env.SYNAP_OBS_KEY;
  if (!url || !key || !fetchImpl) return null;
  async function req(method, path, body) {
    const res = await fetchImpl(`${url}/api/hub${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`
      );
    return text ? JSON.parse(text) : null;
  }
  return {
    workspaceId: env.SYNAP_POD_WORKSPACE_ID || null,
    /** Post into a session's room (its channel), as the session's owner. */
    async postToSession(sessionId, content) {
      const s = await req("GET", `/focus-sessions/${sessionId}`);
      if (!s?.channelId) throw new Error(`session ${sessionId} has no room`);
      await req("POST", `/threads/${s.channelId}/messages`, {
        role: "assistant",
        content,
        userId: s.userId,
      });
    },
    /** The active sessions of the configured space. */
    async activeSessions() {
      if (!env.SYNAP_POD_WORKSPACE_ID)
        throw new Error("SYNAP_POD_WORKSPACE_ID is not set");
      const rows = await req(
        "GET",
        `/focus-sessions?workspaceId=${env.SYNAP_POD_WORKSPACE_ID}&status=active&limit=50`
      );
      return (Array.isArray(rows) ? rows : []).map((s) => ({
        title: s.title ?? s.goal ?? "",
        status: s.status,
        startedAt: s.startedAt,
      }));
    },
  };
}

// ── GitHub reads ────────────────────────────────────────────────────────────

/** A PR as the rules read it. */
function prShape(p) {
  return {
    number: p.number,
    title: p.title ?? "",
    head: p.head?.ref ?? "",
    body: p.body ?? "",
    mergedAt: p.merged_at ?? null,
    createdAt: p.created_at ?? null,
    state: p.merged_at ? "merged" : p.state,
    mergeSha: p.merge_commit_sha ?? null,
    session: podSessionOf(p.body),
    url: p.html_url,
  };
}

/** Every changed path of a PR (paginated), or null when unreadable. */
function prFiles(gh, repo, n, log) {
  const files = [];
  try {
    for (let page = 1; page <= 30; page++) {
      const batch =
        gh.rest(`repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`) ??
        [];
      files.push(...batch.map((f) => f.filename));
      if (batch.length < 100) return files;
    }
    return files;
  } catch (e) {
    log(
      `::warning::#${n}: its files could not be read (${e.message}); it is taken as reaching every file`
    );
    return null;
  }
}

/** The failed jobs of a run and the failing files their logs name. */
function readFailing(gh, repo, runId, dirsByName, log) {
  const jobs =
    gh.rest(
      `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`
    )?.jobs ?? [];
  const failed = jobs.filter((j) => j.conclusion === "failure");
  const failing = [];
  const seen = new Set();
  for (const j of failed) {
    let text = "";
    try {
      text =
        gh.rest(`repos/${repo}/actions/jobs/${j.id}/logs`, { raw: true }) ?? "";
    } catch (e) {
      log(`::warning::${j.name}: its log could not be read (${e.message})`);
      continue;
    }
    for (const f of failingFiles(text, { dirsByName }))
      if (!seen.has(f.file)) {
        seen.add(f.file);
        failing.push({ ...f, check: j.name });
      }
  }
  return { failing, failedJobs: failed.map((j) => j.name) };
}

/** First-parent commits of `sha` (itself first): [[sha, subject]]. */
function firstParentLine(sh, sha, limit) {
  const r = sh("git", [
    "log",
    "--first-parent",
    "--format=%H%x09%s",
    `-n${limit + 1}`,
    sha,
  ]);
  if (r.code !== 0) throw new Error(`git log ${short(sha)}: ${r.out.trim()}`);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
}

/** The record check run of a commit, or null. */
function readRecordOf(gh, repo, sha) {
  const runs =
    gh.rest(
      `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(RECORD_CHECK)}&per_page=20`
    )?.check_runs ?? [];
  for (const r of runs) {
    const rec = readRecord(r.output?.text);
    if (rec) return rec;
  }
  return null;
}

// ── name ────────────────────────────────────────────────────────────────────

/**
 * Read a red main run and decide who did it. Returns { plan, toBisect }:
 * plan = everything bisect and post need (JSON-safe).
 */
export function nameRun({
  gh,
  sh,
  repo,
  runId,
  root = REPO_ROOT,
  log,
  readVerdict,
}) {
  const run = gh.rest(`repos/${repo}/actions/runs/${runId}`);
  if (run.event !== "push" || run.head_branch !== "main")
    throw new Error(
      `run ${runId} is not a push run of main (${run.event} ${run.head_branch})`
    );
  const redSha = run.head_sha;
  const packages = workspacePackages(root);
  const dirsByName = new Map(packages.map((p) => [p.name, p.dir]));
  const { failing, failedJobs } = readFailing(gh, repo, runId, dirsByName, log);
  log(
    `run ${runId} of ${short(redSha)}: failed jobs ${failedJobs.join(", ") || "none"}; ${failing.length} failing file(s)`
  );
  const line = firstParentLine(sh, redSha, RANGE_LIMIT);
  const subject = new Map(line);
  const verdictOf =
    readVerdict ??
    ((c) => {
      try {
        return decide(githubReader(repo, c)());
      } catch {
        return { verdict: "fail" };
      }
    });
  const range = culpritRange(
    line.slice(1).map(([h]) => h),
    verdictOf
  );
  const shas = [redSha, ...range.suspects].reverse(); // oldest first
  const candidates = shas.map((sha) => {
    let pr = prOfSubject(subject.get(sha));
    if (pr == null) {
      try {
        const pulls = gh.rest(`repos/${repo}/commits/${sha}/pulls`) ?? [];
        pr = pulls.find((p) => p.merge_commit_sha === sha)?.number ?? null;
      } catch {
        pr = null;
      }
    }
    const files = pr == null ? null : prFiles(gh, repo, pr, log);
    return { sha, pr, subject: subject.get(sha) ?? "", files };
  });
  const g = loadGraph(root, isTripwire);
  const attribution = attribute(failing, candidates, { ...g, isTripwire });
  const toBisect = range.lastGreen ? needsBisect(failing, attribution) : [];
  if (!range.lastGreen)
    log(
      `no all-green main commit in the last ${RANGE_LIMIT}: no bisect (its lower end is unknown)`
    );
  const plan = {
    repo,
    runId: Number(runId),
    runUrl: run.html_url,
    redSha,
    lastGreen: range.lastGreen,
    failing,
    failedJobs,
    candidates: candidates.map(({ sha, pr, subject }) => ({
      sha,
      pr,
      subject,
    })),
    attribution: Object.fromEntries(attribution),
    bisect: toBisect.map((f) => f.file),
  };
  return { plan, candidates, attribution, toBisect };
}

// ── bisect: the probes ──────────────────────────────────────────────────────

/** The `--filter=` list of the composite action's build step (one source). */
export function buildFilters(actionYaml) {
  return [...String(actionYaml).matchAll(/--filter='([^']+)'/g)].map(
    (m) => m[1]
  );
}

/**
 * A probe on a real checkout: check out `sha`, install, build, then run each
 * file by its kind. Returns Map file → "pass" | "fail" | "absent" | "error".
 */
export function makeProbe({
  sh,
  root,
  log,
  env = process.env,
  filters,
  kinds,
}) {
  const kindOf = (f) => kinds?.get(f) ?? (TEST_FILE.test(f) ? "test" : "lint");
  return async (sha, files) => {
    const res = new Map();
    const step = (cmd, args, opts = {}) => {
      const r = sh(cmd, args, { cwd: root, env, ...opts });
      if (r.code !== 0)
        log(
          `  ${cmd} ${args.join(" ")} → exit ${r.code}\n${r.out.slice(-2000)}`
        );
      return r;
    };
    const all = (v) => {
      for (const f of files) res.set(f, v);
      return res;
    };
    log(`probe ${short(sha)}: ${files.join(", ")}`);
    if (step("git", ["checkout", "--force", "--detach", sha]).code !== 0)
      return all("error");
    step("git", ["clean", "-fdq"]);
    if (
      step("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"])
        .code !== 0
    )
      return all("error");
    step("pnpm", ["turbo", "build", ...filters.map((f) => `--filter=${f}`)]);
    if (existsSync(join(root, "skills/build.mjs")))
      step("node", ["skills/build.mjs"]);
    const dirs = workspacePackages(root).map((p) => p.dir);
    const pkgJson = (pkg) =>
      JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8"));
    // The tests read a migrated database: a fresh one per probe (migrations
    // differ from commit to commit).
    let testEnv = { ...env, NODE_ENV: "test" };
    if (files.some((f) => kindOf(f) === "test") && env.DATABASE_ADMIN_URL) {
      const db = `probe_${sha.slice(0, 12)}`;
      step("psql", [env.DATABASE_ADMIN_URL, "-c", `CREATE DATABASE "${db}"`]);
      testEnv = {
        ...testEnv,
        DATABASE_URL: env.DATABASE_ADMIN_URL.replace(/\/[^/]*$/, `/${db}`),
      };
      if (
        step("pnpm", ["--filter", "@synap/database", "migrate"], {
          env: testEnv,
        }).code !== 0
      )
        return all("error");
    }
    const typechecked = new Map();
    for (const file of files) {
      if (!existsSync(join(root, file))) {
        res.set(file, "absent");
        continue;
      }
      const pkg = packageOf(file, dirs);
      const cwd = join(root, pkg ?? ".");
      const kind = kindOf(file);
      let r;
      if (kind === "test") {
        // The package's own vitest flags (as the ratchet's retry runs a file).
        const script = String((pkg ? pkgJson(pkg).scripts?.test : "") ?? "");
        const flags = /^vitest run\b/.test(script)
          ? script
              .split(/\s+/)
              .slice(2)
              .filter((a) => a.startsWith("-") && !a.startsWith("--shard"))
          : [];
        r = sh(
          "pnpm",
          ["exec", "vitest", "run", ...flags, relative(cwd, join(root, file))],
          {
            cwd,
            env: testEnv,
          }
        );
      } else if (kind === "lint") {
        r = sh("pnpm", ["exec", "prettier", "--check", file], {
          cwd: root,
          env,
        });
        if (r.code === 0 && /\.(m?[jt]sx?|c[jt]s)$/.test(file))
          r = sh("pnpm", ["exec", "eslint", file], { cwd: root, env });
      } else if (kind === "type" && pkg) {
        if (!typechecked.has(pkg)) {
          const s = pkgJson(pkg).scripts ?? {};
          const name = s.typecheck
            ? "typecheck"
            : s["type-check"]
              ? "type-check"
              : null;
          typechecked.set(
            pkg,
            name ? sh("pnpm", ["run", name], { cwd, env }) : null
          );
        }
        r = typechecked.get(pkg);
      }
      res.set(file, !r ? "error" : r.code === 0 ? "pass" : "fail");
      log(`  ${file} (${kind}) at ${short(sha)}: ${res.get(file)}`);
    }
    return res;
  };
}

// ── post the verdict ────────────────────────────────────────────────────────

/** Comment on each culprit, post to its session, write the record. */
export async function postVerdict({
  gh,
  pod,
  repo,
  plan,
  v,
  now,
  log,
  dryRun,
}) {
  const record = {
    v: 1,
    redSha: plan.redSha,
    runId: plan.runId,
    runUrl: plan.runUrl,
    lastGreen: plan.lastGreen,
    failing: plan.failing,
    candidates: plan.candidates,
    culprits: [],
    unattributed: v.unattributed,
    revertable: v.revertable,
    why: v.why,
    bisected: plan.bisect,
  };
  for (const c of v.culprits) {
    const entry = {
      ...c,
      namedAt: new Date(now).toISOString(),
      namedFiles: c.files.map((f) => f.file),
    };
    record.culprits.push(entry);
    if (c.pr == null) continue;
    let comments = [];
    try {
      comments =
        gh.rest(`repos/${repo}/issues/${c.pr}/comments?per_page=100`) ?? [];
    } catch (e) {
      log(`::warning::#${c.pr}: its comments could not be read (${e.message})`);
    }
    const prior = comments
      .map((cm) => ({ cm, m: readMarker(cm.body) }))
      .find(({ m }) => m?.merge === c.sha);
    if (prior) {
      entry.namedAt = prior.m.namedAt ?? prior.cm.created_at;
      entry.namedFiles = prior.m.files ?? entry.namedFiles;
      log(`#${c.pr}: already named at ${entry.namedAt}; not posted again`);
      continue;
    }
    const body = culpritComment({
      record,
      culprit: entry,
      namedAt: entry.namedAt,
      revertable: v.revertable,
    });
    if (dryRun) {
      log(`#${c.pr}: WOULD comment:\n${body}`);
      continue;
    }
    try {
      gh.rest(`repos/${repo}/issues/${c.pr}/comments`, {
        method: "POST",
        body: { body },
      });
      log(`#${c.pr}: named as the culprit (comment posted)`);
    } catch (e) {
      log(
        `::warning::#${c.pr}: the comment could not be posted (${e.message})`
      );
    }
    let pr = null;
    try {
      pr = prShape(gh.rest(`repos/${repo}/pulls/${c.pr}`));
    } catch (e) {
      log(
        `::warning::#${c.pr}: the PR could not be read (${e.message}); its pod session is not told`
      );
      continue;
    }
    if (!pr.session) log(`#${c.pr}: no Pod session line; no room to post to`);
    else if (!pod)
      log(
        `#${c.pr}: the pod is not configured (SYNAP_POD_URL / SYNAP_OBS_KEY); session ${pr.session} not told`
      );
    else
      try {
        await pod.postToSession(
          pr.session,
          podMessage({
            record,
            culprit: entry,
            prUrl: pr.url,
            revertable: v.revertable,
          })
        );
        log(`#${c.pr}: posted to pod session ${pr.session}`);
      } catch (e) {
        log(`::warning::#${c.pr}: the pod post failed (${e.message})`);
      }
  }
  const summary = [
    `### Red main: culprit of \`${short(plan.redSha)}\``,
    "",
    plan.lastGreen
      ? `Range: \`${short(plan.lastGreen)}..${short(plan.redSha)}\` (${plan.candidates.length} commit(s)).`
      : "No all-green main in range.",
    "",
    ...record.culprits.flatMap((c) => [
      `**${c.pr ? `#${c.pr}` : short(c.sha)}** (${c.confidence}):`,
      ...fileLines(c.files),
      "",
    ]),
    ...(v.unattributed.length
      ? [
          "Not attributed:",
          ...v.unattributed.map((u) => `- \`${u.file}\` (${u.kind}): ${u.why}`),
          "",
        ]
      : []),
    v.revertable
      ? `Revertable after ${GRACE_MINUTES} min with no owner.`
      : `No automatic revert: ${v.why.join("; ")}.`,
  ].join("\n");
  log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (dryRun) return record;
  try {
    gh.rest(`repos/${repo}/check-runs`, {
      method: "POST",
      body: {
        name: RECORD_CHECK,
        head_sha: plan.redSha,
        status: "completed",
        conclusion: "neutral",
        output: {
          title: record.culprits.length
            ? `Culprit: ${record.culprits.map((c) => (c.pr ? `#${c.pr}` : short(c.sha))).join(", ")}`
            : "No culprit named",
          summary,
          text: recordText(record),
        },
      },
    });
  } catch (e) {
    log(
      `::warning::the record could not be written (${e.message}); the sweep cannot revert this red`
    );
  }
  return record;
}

// ── sweep ───────────────────────────────────────────────────────────────────

/** One sweep: judge, then revert (or hold, or log). Returns the decision. */
export async function sweep({ gh, sh, pod, repo, now, log, token, dryRun }) {
  const runs =
    gh.rest(
      `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&event=push&per_page=20`
    )?.workflow_runs ?? [];
  const sorted = [...runs].sort((a, b) => at(b.created_at) - at(a.created_at));
  const latest =
    sorted.find(
      (r) => r.status === "completed" && r.conclusion !== "cancelled"
    ) ?? null;
  const newerRunning = latest
    ? sorted.some(
        (r) =>
          r.status !== "completed" && at(r.created_at) > at(latest.created_at)
      )
    : false;
  const main = { latest, newerRunning };
  let record = null;
  if (latest && latest.conclusion !== "success" && !newerRunning)
    record = readRecordOf(gh, repo, latest.head_sha);
  const c = record?.culprits?.[0];
  let culpritPr = null;
  let openPrs = [];
  let revertPrs = [];
  let branchExists = false;
  let owners = { ok: false, why: "not read" };
  if (record?.revertable && c?.pr) {
    culpritPr = prShape(gh.rest(`repos/${repo}/pulls/${c.pr}`));
    const all =
      gh.rest(
        `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`
      ) ?? [];
    openPrs = all.filter((p) => p.state === "open").map(prShape);
    revertPrs = all.map(prShape).filter((p) => REVERT_BRANCH_RE.test(p.head));
    try {
      gh.rest(`repos/${repo}/git/ref/heads/${revertBranch(c.pr, c.sha)}`);
      branchExists = true;
    } catch (e) {
      if (!/404|Not Found/i.test(e.message)) throw e;
    }
    if (!pod)
      owners = {
        ok: false,
        why: "the pod is not configured (SYNAP_POD_URL / SYNAP_OBS_KEY / SYNAP_POD_WORKSPACE_ID)",
      };
    else
      try {
        owners = { ok: true, sessions: await pod.activeSessions() };
      } catch (e) {
        owners = { ok: false, why: `the pod read failed: ${e.message}` };
      }
  }
  const d = revertDecision({
    now,
    main,
    record,
    culpritPr,
    openPrs,
    revertPrs,
    branchExists,
    owners,
    token: Boolean(token),
  });
  log(
    `sweep: ${d.revert ? "REVERT" : "no revert"}: ${d.reasons.join("; ") || "all conditions hold"}`
  );
  if (d.hold && culpritPr && !dryRun)
    postOnce(
      gh,
      repo,
      culpritPr.number,
      HELD_MARK,
      c.sha,
      `The automatic revert of this merge is held: ${d.hold}. The bot does not revert while someone owns the fix (founder decision ${FOUNDER_DECISION}).`,
      log
    );
  if (!d.revert) return d;
  if (dryRun) {
    log(
      `WOULD revert #${culpritPr.number} (${c.sha}) on ${revertBranch(culpritPr.number, c.sha)}`
    );
    return d;
  }
  await openRevert({
    gh,
    sh,
    pod,
    repo,
    record,
    culprit: c,
    culpritPr,
    token,
    log,
  });
  return d;
}

/** A comment posted once per (marker, merge sha). */
function postOnce(gh, repo, n, mark, sha, text, log) {
  try {
    const comments =
      gh.rest(`repos/${repo}/issues/${n}/comments?per_page=100`) ?? [];
    if (comments.some((cm) => readMarker(cm.body, mark)?.merge === sha)) return;
    gh.rest(`repos/${repo}/issues/${n}/comments`, {
      method: "POST",
      body: {
        body: `<!-- ${mark} ${JSON.stringify({ merge: sha })} -->\n${text}`,
      },
    });
  } catch (e) {
    log(`::warning::#${n}: could not post (${e.message})`);
  }
}

/** git revert on origin/main, push the revert branch (never main), open the PR. */
export async function openRevert({
  gh,
  sh,
  pod,
  repo,
  record,
  culprit,
  culpritPr,
  token,
  log,
}) {
  const branch = revertBranch(culpritPr.number, culprit.sha);
  if (!REVERT_BRANCH_RE.test(branch) || branch === "main")
    throw new Error(`refusing to push ${branch}`);
  const git = (...args) => sh("git", args);
  const must = (r, what) => {
    if (r.code !== 0) throw new Error(`${what}: ${r.out.trim().slice(-500)}`);
    return r;
  };
  must(
    git(
      "fetch",
      "--no-tags",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main"
    ),
    "git fetch main"
  );
  must(
    git("checkout", "--force", "-B", branch, "refs/remotes/origin/main"),
    "git checkout"
  );
  const parents =
    must(git("rev-list", "--parents", "-n1", culprit.sha), "git rev-list")
      .out.trim()
      .split(/\s+/).length - 1;
  must(git("config", "user.name", "Synap Merge Bot"), "git config");
  must(
    git(
      "config",
      "user.email",
      "synap-merge-bot[bot]@users.noreply.github.com"
    ),
    "git config"
  );
  const rev = git(
    "revert",
    "--no-commit",
    ...(parents > 1 ? ["-m", "1"] : []),
    culprit.sha
  );
  if (rev.code !== 0) {
    git("revert", "--abort");
    log(
      `::warning::the revert of ${short(culprit.sha)} conflicts with main; a person reverts it`
    );
    postOnce(
      gh,
      repo,
      culpritPr.number,
      CONFLICT_MARK,
      culprit.sha,
      `The automatic revert of this merge conflicts with today's main, so the bot did not open it. One owner reverts or fixes it by hand (founder decision ${FOUNDER_DECISION}).`,
      log
    );
    return null;
  }
  must(
    git(
      "commit",
      "-m",
      `Revert #${culpritPr.number}: ${culpritPr.title}\n\nThis reverts merge ${culprit.sha}, named by the culprit finder as the cause of main's red run ${record.runUrl}.\n\nRevert-first: founder decision ${FOUNDER_DECISION}.`
    ),
    "git commit"
  );
  // The token rides one command's header, never a remote URL.
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  must(
    git(
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`,
      "push",
      `https://github.com/${repo}.git`,
      `HEAD:refs/heads/${branch}`
    ),
    `git push ${branch}`
  );
  const pr = gh.rest(`repos/${repo}/pulls`, {
    token,
    method: "POST",
    body: {
      title: `Revert #${culpritPr.number}: ${culpritPr.title}`.slice(0, 250),
      head: branch,
      base: "main",
      draft: false,
      body: revertBody({ record, culprit, culpritPr }),
    },
  });
  log(`opened #${pr?.number} (${branch}), reverting #${culpritPr.number}`);
  postOnce(
    gh,
    repo,
    culpritPr.number,
    `${MARK}-reverted`,
    culprit.sha,
    `Main stayed red on this merge's files for ${GRACE_MINUTES} min with no owner, so the bot opened #${pr?.number}, which reverts it and jumps the merge queue (founder decision ${FOUNDER_DECISION}).`,
    log
  );
  if (pod && culpritPr.session)
    try {
      await pod.postToSession(
        culpritPr.session,
        `Main stayed red for ${GRACE_MINUTES} min with no owner, so the bot opened ${pr?.html_url}, a revert of ${culpritPr.url}. To land the change again, revert the revert in a PR that fixes it.`
      );
    } catch (e) {
      log(`::warning::the pod post failed (${e.message})`);
    }
  return pr;
}

// ── driver ──────────────────────────────────────────────────────────────────

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  gh = ghTransport({ env }),
  sh = realShell,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  log = console.log,
  // The bisect job runs a copy of this script from $RUNNER_TEMP (the probes
  // check other commits out): CULPRIT_ROOT names the checkout.
  root = env.CULPRIT_ROOT || REPO_ROOT,
  // One commit's post-merge verdict (default: release-gate-wait's GitHub read).
  readVerdict = undefined,
} = {}) {
  const mode = argv[0];
  const repo = env.GITHUB_REPOSITORY;
  const dryRun = env.CULPRIT_DRY_RUN === "true" || env.CULPRIT_DRY_RUN === "1";
  const pod = podClient(env, fetchImpl);
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  if (mode === "name") {
    const { plan, candidates, attribution, toBisect } = nameRun({
      gh,
      sh,
      repo,
      runId: env.RUN_ID,
      root,
      log,
      readVerdict,
    });
    if (toBisect.length) {
      log(`bisect: ${toBisect.map((f) => f.file).join(", ")}`);
      if (env.GITHUB_OUTPUT) {
        appendFileSync(
          env.GITHUB_OUTPUT,
          `bisect=true\nplan<<__PLAN__\n${JSON.stringify(plan)}\n__PLAN__\n`
        );
      }
      return { plan, bisect: true };
    }
    const v = verdict({ failing: plan.failing, candidates, attribution });
    const record = await postVerdict({
      gh,
      pod,
      repo,
      plan,
      v,
      now,
      log,
      dryRun,
    });
    return { plan, record, bisect: false };
  }
  if (mode === "bisect") {
    const plan = JSON.parse(env.PLAN || readFileSync(env.PLAN_FILE, "utf8"));
    const shas = plan.candidates.map((c) => c.sha);
    const filters = buildFilters(
      readFileSync(
        join(root, ".github/actions/monorepo-setup/action.yml"),
        "utf8"
      )
    );
    const kinds = new Map(plan.failing.map((f) => [f.file, f.kind]));
    const probe = makeProbe({ sh, root, log, env, filters, kinds });
    const { results, probes } = await bisect(shas, plan.bisect, probe);
    log(`bisect: ${probes} probe(s)`);
    const out = { ...plan, bisected: Object.fromEntries(results), probes };
    if (env.RESULT_FILE) writeFileSync(env.RESULT_FILE, JSON.stringify(out));
    return out;
  }
  if (mode === "post") {
    // The bisect's result, or the plan alone when the bisect did not finish:
    // the verdict is then the mapping's, and says what it could not settle.
    const res =
      env.RESULT_FILE && existsSync(env.RESULT_FILE)
        ? JSON.parse(readFileSync(env.RESULT_FILE, "utf8"))
        : JSON.parse(env.PLAN || readFileSync(env.PLAN_FILE, "utf8"));
    const attribution = new Map(Object.entries(res.attribution));
    const v = verdict({
      failing: res.failing,
      candidates: res.candidates,
      attribution,
      bisected: new Map(Object.entries(res.bisected ?? {})),
    });
    return postVerdict({ gh, pod, repo, plan: res, v, now, log, dryRun });
  }
  if (mode === "sweep")
    return sweep({
      gh,
      sh,
      pod,
      repo,
      now,
      log,
      token: env.REVERT_TOKEN || "",
      dryRun,
    });
  throw new Error("usage: culprit-finder.mjs name | bisect | post | sweep");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.log(`::error::culprit finder: ${e.message}`);
      process.exit(1);
    }
  );
}
