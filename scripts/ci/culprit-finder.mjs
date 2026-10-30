#!/usr/bin/env node
/**
 * culprit-finder.mjs: name the PR that made backend main red, and revert it
 * when nobody fixes it (founder decision 0b4db9f7, 2026-10-29 ~13:10Z:
 * "When backend main goes red, name the culprit PR and post to its pod
 * session; after 30 min with no fix from that session, the bot opens a
 * revert PR and it jumps the merge queue").
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * A PR runs only the tests of what it can break; main's post-merge run is the
 * first to run everything (ci.yml, "One trunk, three CI tiers"). On 29 Oct
 * five PRs merged at 01:00Z, run 40797830929 went red at 01:46Z, and main
 * stayed red until 09:54Z. The culprits (#467, a lint error in its own test
 * file; #476, three test files that read the tables it added) were knowable
 * at 01:46Z. Prior art (pod document cd1bf4e9, Google TAP and Build Cop):
 * "the most effective tool the Build Cop has is the rollback".
 *
 * ── MODES (.github/workflows/red-main.yml) ───────────────────────────────────
 * name    a push run of CI on main ended `failure`: failingFiles() of its
 *         failed jobs, the first-parent commits since the last all-green main
 *         (release-gate-wait.mjs culpritRange), each commit's PR and files,
 *         then attribute(). Posts at once when every re-runnable file is
 *         settled at `high`; else hands a plan to `bisect`.
 * bisect  ONE job, no token: bisect() re-runs only the unsettled files at a
 *         few commits of the range. Its result is untrusted data.
 * post    main's own finder: checks the bisect result against the plan, then
 *         verdict() and postVerdict().
 * sweep   every 10 min: revertDecision() (THE REVERT RULE), then openRevert().
 *
 * A verdict is posted as a comment on each culprit PR (once per culprit
 * merge: a hidden marker carries its files and when it was first named), a
 * message in the culprit's pod session room (the `Pod session:` line), posted
 * as the pod key's owner, and the check run RECORD_CHECK on the red commit,
 * whose text holds the record as JSON. The sweep reads a record only from a
 * check suite of a red-main.yml run on main (recordOf).
 *
 * Env: GITHUB_REPOSITORY, GH_TOKEN, RUN_ID (name), PLAN and RESULT (bisect,
 * post), REVERT_TOKEN (sweep: the merge bot app's token), SYNAP_POD_URL +
 * SYNAP_OBS_KEY + SYNAP_POD_WORKSPACE_ID (the pod), CULPRIT_ROOT (the
 * checkout, when the script runs from a copy), CULPRIT_DRY_RUN=true.
 * Transport: the `gh` CLI, global fetch and a shell, all injected (the
 * tripwire drives them with fakes). Node built-ins only.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { podSessionFromBody } from "../pod-observation.mjs";
import { isTripwire } from "../tripwire-discovery.mjs";
import {
  TEST_FILE,
  loadGraph,
  packageOf,
  selectPackageTier,
  workspacePackages,
} from "./affected.mjs";
import {
  CI_WORKFLOW,
  culpritRange,
  decide,
  githubReader,
} from "./release-gate-wait.mjs";

/** The founder decision this automates (pod decision entity). */
export const FOUNDER_DECISION = "0b4db9f7";
/** Minutes between naming a culprit and reverting it. */
export const GRACE_MINUTES = 30;
/** The check run that carries a red commit's record (not a required check). */
export const RECORD_CHECK = "Red main: culprit";
/** The workflow allowed to write a record. */
export const RECORD_WORKFLOW = ".github/workflows/red-main.yml";
/** A revert branch: the merge bot's `fix/main-red-*` rule makes it jump. */
export const REVERT_BRANCH_RE = /^fix\/main-red-revert-(\d+)-([0-9a-f]{8})$/;
/** A branch that fixes main red (an owner at work), revert branches included. */
export const FIX_BRANCH_RE = /^fix\/main-red-/i;
/** The one owner of a red main (.claude/rules/github-ci.md). */
export const OWNER_TITLE_RE = /^\s*main red:\s*backend\b/i;
/** A migration is forward-only: a PR that adds one is never auto-reverted. */
export const MIGRATION_RE = /^packages\/database\/migrations\//;
/** Failed jobs that fail BECAUSE another job failed: they need not name a file. */
export const JUDGE_JOBS = new Set(["Full suite", "Release gate"]);
/** At most this many probes (checkouts) in one bisect job. */
export const MAX_PROBES = 8;
/** First-parent commits looked at for the last all-green main. */
export const RANGE_LIMIT = 30;

const MARK = "red-main-culprit";
const HELD_MARK = "red-main-held";
const CONFLICT_MARK = "red-main-revert-conflict";
const REVERTED_MARK = "red-main-reverted";
/** The revert PR body line that ties it to one red (its last green main). */
const RED_BASE_LINE = "Red-main-base:";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const at = (iso) => (iso ? Date.parse(iso) : NaN);
const short = (s) => String(s ?? "").slice(0, 9);

// ── pure: reading the run ───────────────────────────────────────────────────

/** The PR number of a GitHub merge commit subject, or null. */
export function prOfSubject(subject) {
  const m = /^Merge pull request #(\d+) from /.exec(String(subject ?? ""));
  return m ? Number(m[1]) : null;
}

/** A merge that fixes main red: a `fix/main-red-*` branch (reverts included) or a `Revert` title. */
export function isFixMerge(message) {
  const [subject, , title] = String(message ?? "").split("\n");
  return (
    /^Merge pull request #\d+ from [^/\s]+\/fix\/main-red-/i.test(
      subject ?? ""
    ) ||
    /^Revert\b/i.test(subject ?? "") ||
    /^Revert\b/i.test(title ?? "")
  );
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
 * Only what the log NAMES; a red job that names no file adds nothing (and is
 * a `silent` job: readFailing).
 */
export function failingFiles(log, { dirsByName = new Map() } = {}) {
  const out = new Map();
  const add = (file, kind) => {
    if (file && !out.has(file)) out.set(file, kind);
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
 * May a change of `prFiles` make `file` fail? Through the package graph
 * (affected.mjs selectPackageTier: the tier PRs ran before lane L8, wider
 * than the file-level selection they run now): the full suite reaches
 * everything; otherwise its packages, their dependents and the test files
 * that read them. A tripwire reads across the tree, so every change reaches
 * it.
 */
export function reaches(prFiles, file, { graph, refs, isTripwire: trip }) {
  const files = (prFiles ?? []).filter((f) => !neutralPath(f));
  if (files.length === 0) return false;
  if (trip?.(file)) return true;
  const t = selectPackageTier(files, { graph, refs });
  if (t.scope === "full") return true;
  const pkg = packageOf(file, [...graph.keys()]);
  return (pkg != null && t.dirs.includes(pkg)) || t.tests.includes(file);
}

/** Kinds a probe can re-run at another commit. */
export const BISECTABLE = new Set(["test", "lint", "type"]);

/**
 * Per failing file, which candidate commit made it fail, by the cheapest
 * correct method. `candidates` oldest first: [{ sha, pr, files }] (files =
 * the PR's changed paths, null when unread: such a PR reaches everything).
 * Returns Map file → { method, confidence, shas }:
 *   range      one commit in the range: it (high)
 *   direct     exactly one PR changed the file: high only when NO OTHER
 *              candidate can reach the file, else medium (a rename in one PR
 *              breaks a file another PR only touched: the bisect decides)
 *   reach      no PR changed it and exactly one can reach it (medium)
 *   ambiguous  several PRs changed it, or several reach it (low)
 *   none       nothing in the range reaches it: a flake or the environment
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
    const reach = candidates.filter(
      (c) => c.files == null || reaches(c.files, file, deps)
    );
    if (direct.length === 1) {
      const others = reach.filter((c) => c.sha !== direct[0].sha).length;
      out.set(file, {
        method: "direct",
        confidence: others === 0 ? "high" : "medium",
        shas: [direct[0].sha],
        others,
      });
    } else if (direct.length > 1)
      out.set(file, {
        method: "ambiguous",
        confidence: "low",
        shas: direct.map((c) => c.sha),
      });
    else if (reach.length === 1)
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

/** A suspect per file for the bisect to confirm first (a medium attribution). */
export function bisectHints(files, attribution) {
  return new Map(
    files
      .map((f) => [f, attribution.get(f)])
      .filter(([, a]) => a?.confidence === "medium" && a.shas.length === 1)
      .map(([f, a]) => [f, a.shas[0]])
  );
}

/**
 * Find, per file, the first commit of `shas` (oldest first) at which it fails.
 * The commit before shas[0] is the last all-green main, taken as passing.
 * `probe(sha, files)` runs `files` at `sha` → Map file → "pass" | "fail" |
 * "absent" | "error". Probes are cached and shared: each runs every file not
 * yet known at that commit.
 *   1. A file with a hint (a medium suspect): two probes, the suspect (fails?)
 *      and its first parent (passes?). Else, or with no hint:
 *   2. the red commit first (a file passing there alone does not reproduce),
 *      then a binary search.
 *   3. CONFIRM: one fresh probe at each named commit, its files together. A
 *      file that does not fail again is a flake (low), never a culprit.
 * At most `maxProbes` probes in all. Returns { results: Map file → { sha |
 * null, confidence, why }, probes }.
 */
export async function bisect(
  shas,
  files,
  probe,
  { maxProbes = MAX_PROBES, hints = new Map() } = {}
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
  const passes = (r) => r === "pass" || r === "absent";
  const found = new Map(); // file → { idx, why }
  const results = new Map();
  const low = (file, why) =>
    results.set(file, { sha: null, confidence: "low", why });
  // Hinted files first: their two probes also serve the searches.
  const order = [...files].sort(
    (a, b) => Number(hints.has(b)) - Number(hints.has(a))
  );
  for (const file of order) {
    const hint = hints.has(file) ? shas.indexOf(hints.get(file)) : -1;
    if (hint >= 0) {
      const a = await result(shas[hint], file);
      const b = hint === 0 ? "pass" : await result(shas[hint - 1], file);
      if (a === "fail" && passes(b)) {
        found.set(file, {
          idx: hint,
          why: `fails at ${short(shas[hint])}, passes at ${hint === 0 ? "the last all-green main" : `${short(shas[hint - 1])} (its first parent on main)`}`,
        });
        continue;
      }
    }
    const tip = shas.length - 1;
    const atTip = await result(shas[tip], file);
    if (atTip !== "fail") {
      low(
        file,
        atTip === "budget"
          ? `not probed: the bisect used its ${maxProbes} probes`
          : `did not fail when run alone at the red commit (${atTip})`
      );
      continue;
    }
    let lo = -1;
    let hi = tip;
    let stuck = null;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await result(shas[mid], file);
      if (r === "fail") hi = mid;
      else if (passes(r)) lo = mid;
      else {
        stuck = r;
        break;
      }
    }
    if (stuck) {
      low(
        file,
        stuck === "budget"
          ? `narrowed to ${shas
              .slice(lo + 1, hi + 1)
              .map(short)
              .join(", ")}: the bisect used its ${maxProbes} probes`
          : `a probe could not run the file (${stuck})`
      );
      continue;
    }
    found.set(file, {
      idx: hi,
      why: `fails at ${short(shas[hi])}, passes at ${lo === -1 ? "the last all-green main" : `${short(shas[lo])} (its first parent on main)`}`,
    });
  }
  // 3. Confirm: a fresh run at each named commit (a flake failing once at
  // a probed commit would otherwise name it).
  const byIdx = new Map();
  for (const [file, f] of found)
    byIdx.set(f.idx, [...(byIdx.get(f.idx) ?? []), file]);
  for (const [idx, group] of byIdx) {
    if (probes >= maxProbes) {
      for (const file of group)
        low(
          file,
          `${found.get(file).why}; not confirmed: the bisect used its ${maxProbes} probes`
        );
      continue;
    }
    probes++;
    const again = await probe(shas[idx], group);
    for (const file of group) {
      const r = again.get(file) ?? "error";
      if (r === "fail")
        results.set(file, {
          sha: shas[idx],
          confidence: "high",
          why: `bisect: ${found.get(file).why}, and failed again on a repeat`,
        });
      else
        low(
          file,
          `${found.get(file).why}, but did not fail on a repeat (${r}): a flake?`
        );
    }
  }
  return { results, probes };
}

/**
 * The verdict: culprits grouped by PR, and whether a revert can even be
 * considered. Input: failing, candidates [{sha, pr, migration?}],
 * attribution, bisected (Map | null), lastGreen, silentJobs ([job names]).
 * Returns { culprits: [{ sha, pr, confidence, files }], unattributed,
 * revertable, why }. Revertable needs ALL of: an all-green main below the
 * range; no failed job that names no file; exactly one culprit, a PR merge,
 * at high confidence, explaining every failing file; no ratchet-baseline red
 * among its files (a revert would undo a test fix); it adds no migration
 * (forward-only: a person decides).
 */
export function verdict({
  failing,
  candidates,
  attribution,
  bisected = null,
  lastGreen = null,
  silentJobs = [],
}) {
  const bySha = new Map(candidates.map((c) => [c.sha, c]));
  const groups = new Map();
  const unattributed = [];
  const RANK = { high: 3, medium: 2, low: 1 };
  for (const f of failing) {
    const a = attribution.get(f.file);
    const b = bisected?.get(f.file);
    let sha = null;
    let confidence;
    let why;
    if (a?.confidence === "high") {
      sha = a.shas[0];
      confidence = "high";
      why =
        a.method === "range"
          ? "the only commit since the last all-green main"
          : "the only PR in the range that changed this file, and no other can reach it";
    } else if (b?.sha) {
      sha = b.sha;
      confidence = b.confidence;
      why = b.why;
    } else if (a?.confidence === "medium") {
      sha = a.shas[0];
      confidence = "medium";
      why = `${a.method === "direct" ? `the only PR that changed this file, but ${a.others} other PR(s) can reach it` : "the only PR in the range that can reach this file (affected graph)"}${b ? `; bisect: ${b.why}` : ""}`;
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
  if (!lastGreen)
    why.push(
      `no all-green main in the last ${RANGE_LIMIT} commits (the range has no lower end)`
    );
  if (failing.length === 0) why.push("the red run names no failing file");
  if (silentJobs.length)
    why.push(
      `${silentJobs.join(", ")} failed and named no file (a revert may not green it)`
    );
  if (culprits.length !== 1)
    why.push(`${culprits.length} culprits (a revert needs exactly one)`);
  const only = culprits.length === 1 ? culprits[0] : null;
  if (only && only.files.some((f) => f.confidence !== "high"))
    why.push("the culprit is not high confidence on every file");
  if (only && only.pr == null) why.push("the culprit commit is not a PR merge");
  if (only?.files.some((f) => f.kind === "fixed" || f.kind === "stale"))
    why.push(
      "a test-ratchet baseline red (fixed / stale-baseline): reverting would undo a test fix"
    );
  if (only && bySha.get(only.sha)?.migration)
    why.push("the culprit adds a migration (forward-only): a person decides");
  if (unattributed.length)
    why.push(`${unattributed.length} failing file(s) no culprit explains`);
  return { culprits, unattributed, revertable: why.length === 0, why };
}

/**
 * A bisect result is data from a job that ran merged code: keep only what the
 * plan allows (the plan's own files, the range's own commits), so a probe
 * cannot name a commit outside the range or add a file.
 */
export function trustedBisect(plan, result) {
  const files = new Set(plan.bisect ?? []);
  const shas = new Set((plan.candidates ?? []).map((c) => c.sha));
  const out = new Map();
  for (const [file, r] of Object.entries(result?.bisected ?? {})) {
    if (!files.has(file) || !r || typeof r !== "object") continue;
    if (r.sha != null && !shas.has(r.sha)) continue;
    out.set(file, {
      sha: r.sha ?? null,
      confidence: r.sha ? "high" : "low",
      why: String(r.why ?? "").slice(0, 300),
    });
  }
  return out;
}

// ── pure: the revert rule ───────────────────────────────────────────────────

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
 * THE REVERT RULE: may the sweep open the revert now? Pure. Input:
 *   now           ms
 *   main          { latest: finished push run | null, fixRunning: bool (a
 *                 newer push run of a fix/main-red-* or revert merge runs) }
 *   record        the latest red run's record (from red-main.yml), or null
 *   culpritPr     { number, title, head, mergedAt, mergeSha, session }
 *   onMainLine    the culprit's merge is on main's first-parent line in
 *                 (lastGreen, latest]
 *   openPrs       [{ number, head, body, createdAt }]
 *   priorReverts  [{ number, head, body, state }] (this branch, any state, and
 *                 recent revert branches)
 *   branchExists  the revert branch exists
 *   owners        { ok: true, sessions } | { ok: false, why }
 *   token         the app token is present
 * It reverts only when ALL hold: main is red and no fix is running; the
 * record is revertable (verdict()); the culprit is that PR's merge commit, on
 * main's line, and not itself a revert; it was first named GRACE_MINUTES ago
 * and the files it was named for still fail; this red has had no revert
 * (any state: a closed one is a person saying no) and the branch is free;
 * NOBODY OWNS THE FIX: no `fix/main-red-*` PR, and no PR from the culprit's
 * pod session, opened after the culprit merged; no ACTIVE `main red:
 * backend …` session started after it merged (a pod that is not read is an
 * UNKNOWN owner, and an unknown owner holds it); the token is present.
 * An owner holds the revert for as long as it is open, with no deadline; the
 * grace window starts at the first naming and never restarts.
 * Returns { revert, hold: string | null, reasons }.
 */
export function revertDecision(input) {
  const { now, main, record, culpritPr } = input;
  const no = (why) => ({ revert: false, hold: null, reasons: [why] });
  if (!main?.latest) return no("no finished push run on main");
  if (main.latest.conclusion === "success") return no("main is green");
  if (main.fixRunning)
    return no("a newer main run of a main-red fix or revert is still running");
  if (!record) return no("the red run has no culprit record yet");
  if (!record.revertable)
    return no(
      `not revertable: ${(record.why ?? []).join("; ") || "no reason recorded"}`
    );
  const c = record.culprits?.[0];
  if (!c || !culpritPr) return no("the culprit PR is not read");
  if (isRevert(culpritPr))
    return no(`#${culpritPr.number} is a revert: never revert a revert`);
  const r = [];
  if (culpritPr.mergeSha !== c.sha)
    r.push(
      `the record's commit ${short(c.sha)} is not #${culpritPr.number}'s merge (${short(culpritPr.mergeSha)})`
    );
  if (!input.onMainLine)
    r.push(
      `${short(c.sha)} is not on main's first-parent line after ${short(record.lastGreen)}`
    );
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
  const prior = (input.priorReverts ?? []).find(
    (p) =>
      p.head === branch ||
      (REVERT_BRANCH_RE.test(p.head) &&
        String(p.body ?? "").includes(`${RED_BASE_LINE} ${record.lastGreen}`))
  );
  if (prior)
    r.push(
      `this red already had its revert (#${prior.number}, ${prior.state})`
    );
  if (input.branchExists) r.push(`the branch ${branch} exists`);
  // The one owner: a person or a session already fixing THIS red.
  const merged = at(culpritPr.mergedAt);
  const after = (iso) => !(at(iso) < merged);
  const open = (input.openPrs ?? []).filter(
    (p) => p.number !== culpritPr.number && after(p.createdAt)
  );
  let hold = null;
  const fixPr = open.find((p) => FIX_BRANCH_RE.test(p.head));
  if (fixPr) hold = `#${fixPr.number} (${fixPr.head}) is open`;
  const fromSession = culpritPr.session
    ? open.find((p) => podSessionFromBody(p.body) === culpritPr.session)
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
          after(s.startedAt)
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

/** The hidden marker of a bot comment, and its parse. */
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

/** The comment on a culprit PR (the marker is added by postOnce). */
export function culpritComment({ record, culprit, revertable }) {
  const until = new Date(
    at(culprit.namedAt) + GRACE_MINUTES * 60_000
  ).toISOString();
  return [
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
    rest: (path, { token, method = "GET", body, raw } = {}) => {
      const args = [
        "api",
        "-X",
        method,
        path,
        ...(body ? ["--input", "-"] : []),
      ];
      const opts = {
        token,
        input: body ? JSON.stringify(body) : undefined,
        raw,
      };
      if (!raw) return call(args, opts);
      // A job log carries ANSI colour codes, and gh refuses to print terminal
      // escape sequences without this flag (29 Oct 2026: run 40937265099
      // could not read the Full suite log of red main 8fa00a6b, so it named
      // no culprit). An older gh rejects the unknown flag: then plain.
      try {
        return call([...args, "--allow-escape-sequences"], opts);
      } catch (e) {
        if (!/unknown flag: --allow-escape-sequences/.test(e.message)) throw e;
        return call(args, opts);
      }
    },
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

/** The pod door, or null when it is not configured. Posts as the key's owner. */
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
    /** The active sessions of the configured space. A reply that is not a list THROWS. */
    async activeSessions() {
      if (!env.SYNAP_POD_WORKSPACE_ID)
        throw new Error("SYNAP_POD_WORKSPACE_ID is not set");
      const rows = await req(
        "GET",
        `/focus-sessions?workspaceId=${env.SYNAP_POD_WORKSPACE_ID}&status=active&limit=50`
      );
      if (!Array.isArray(rows))
        throw new Error(
          `the session list is not a list (${JSON.stringify(rows)?.slice(0, 120)})`
        );
      return rows.map((s) => ({
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
    session: podSessionFromBody(p.body),
    url: p.html_url,
  };
}

/** A PR's changed paths (paginated) and whether it adds a migration; files null when unreadable. */
function prFiles(gh, repo, n, log) {
  const files = [];
  let migration = false;
  try {
    for (let page = 1; page <= 30; page++) {
      const batch =
        gh.rest(`repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`) ??
        [];
      for (const f of batch) {
        files.push(f.filename);
        if (MIGRATION_RE.test(f.filename) && f.status === "added")
          migration = true;
      }
      if (batch.length < 100) break;
    }
    return { files, migration };
  } catch (e) {
    log(
      `::warning::#${n}: its files could not be read (${e.message}); it is taken as reaching every file`
    );
    return { files: null, migration: false };
  }
}

/**
 * The failed jobs of a run and the failing files their logs name. A failed
 * job that is not a judge and names no file is SILENT: a revert may not green
 * it (an audit, a Docker build, a crash), so the red is not revertable.
 */
function readFailing(gh, repo, runId, dirsByName, log) {
  const jobs =
    gh.rest(
      `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`
    )?.jobs ?? [];
  const failed = jobs.filter((j) => j.conclusion === "failure");
  const failing = [];
  const seen = new Set();
  const silentJobs = [];
  for (const j of failed) {
    let text = null;
    try {
      text = gh.rest(`repos/${repo}/actions/jobs/${j.id}/logs`, { raw: true });
    } catch (e) {
      log(`::warning::${j.name}: its log could not be read (${e.message})`);
    }
    const files = text == null ? [] : failingFiles(text, { dirsByName });
    if (files.length === 0 && !JUDGE_JOBS.has(j.name)) silentJobs.push(j.name);
    for (const f of files)
      if (!seen.has(f.file)) {
        seen.add(f.file);
        failing.push({ ...f, check: j.name });
      }
  }
  return { failing, failedJobs: failed.map((j) => j.name), silentJobs };
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

/**
 * The record of a red commit, from a "Red main: culprit" check run whose
 * check suite is a red-main.yml run on main (a check run posted by any other
 * workflow, or from another branch, is not a record). Null when none.
 */
export function recordOf(gh, repo, sha, log = () => {}) {
  const runs =
    gh.rest(
      `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(RECORD_CHECK)}&per_page=20`
    )?.check_runs ?? [];
  for (const r of runs) {
    const suite = r.check_suite?.id;
    const owner = suite
      ? (gh.rest(`repos/${repo}/actions/runs?check_suite_id=${suite}`)
          ?.workflow_runs ?? [])[0]
      : null;
    if (owner?.path !== RECORD_WORKFLOW || owner?.head_branch !== "main") {
      log(
        `::warning::a "${RECORD_CHECK}" check run on ${short(sha)} is not from ${RECORD_WORKFLOW} on main (${owner?.path ?? "no workflow run"} @ ${owner?.head_branch ?? "?"}): ignored`
      );
      continue;
    }
    const rec = readRecord(r.output?.text);
    if (rec) return rec;
  }
  return null;
}

/**
 * A comment posted once per (marker, merge sha). Returns the earlier marker's
 * data when one exists (nothing posted), else null.
 */
function postOnce(gh, repo, n, mark, data, text, log, dryRun = false) {
  let comments;
  try {
    comments = gh.rest(`repos/${repo}/issues/${n}/comments?per_page=100`) ?? [];
  } catch (e) {
    log(`::warning::#${n}: its comments could not be read (${e.message})`);
    return null;
  }
  for (const cm of comments) {
    const m = readMarker(cm.body, mark);
    if (m?.merge === data.merge) return { ...m, at: m.at ?? cm.created_at };
  }
  const body = `<!-- ${mark} ${JSON.stringify(data)} -->\n${text}`;
  if (dryRun) {
    log(`#${n}: WOULD comment:\n${body}`);
    return null;
  }
  try {
    gh.rest(`repos/${repo}/issues/${n}/comments`, {
      method: "POST",
      body: { body },
    });
    log(`#${n}: commented (${mark})`);
  } catch (e) {
    log(`::warning::#${n}: could not post (${e.message})`);
  }
  return null;
}

// ── name ────────────────────────────────────────────────────────────────────

/** Read a red main run and decide who did it: { plan, candidates, attribution, toBisect }. */
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
  const { failing, failedJobs, silentJobs } = readFailing(
    gh,
    repo,
    runId,
    dirsByName,
    log
  );
  log(
    `run ${runId} of ${short(redSha)}: failed jobs ${failedJobs.join(", ") || "none"}; ${failing.length} failing file(s)${silentJobs.length ? `; silent: ${silentJobs.join(", ")}` : ""}`
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
    const read =
      pr == null
        ? { files: null, migration: false }
        : prFiles(gh, repo, pr, log);
    return { sha, pr, subject: subject.get(sha) ?? "", ...read };
  });
  const g = loadGraph(root, isTripwire, { imports: false });
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
    silentJobs,
    candidates: candidates.map(({ sha, pr, subject: s, migration }) => ({
      sha,
      pr,
      subject: s,
      migration,
    })),
    attribution: Object.fromEntries(attribution),
    bisect: toBisect.map((f) => f.file),
    hints: Object.fromEntries(
      bisectHints(
        toBisect.map((f) => f.file),
        attribution
      )
    ),
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
 * A probe on a real checkout: check out `sha`, install, build what CI builds,
 * migrate a fresh database, then run each file by its kind. Returns Map file
 * → "pass" | "fail" | "absent" | "error".
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
      const db = `probe_${sha.slice(0, 12)}_${Date.now() % 100000}`;
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
          { cwd, env: testEnv }
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
    silentJobs: plan.silentJobs ?? [],
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
    const prior = postOnce(
      gh,
      repo,
      c.pr,
      MARK,
      {
        merge: c.sha,
        red: record.redSha,
        files: entry.namedFiles,
        namedAt: entry.namedAt,
      },
      culpritComment({ record, culprit: entry, revertable: v.revertable }),
      log,
      dryRun
    );
    if (prior) {
      // Named before: the grace window keeps its first start.
      entry.namedAt = prior.namedAt ?? prior.at;
      entry.namedFiles = prior.files ?? entry.namedFiles;
      log(`#${c.pr}: already named at ${entry.namedAt}; not posted again`);
      continue;
    }
    if (dryRun) continue;
    let pr;
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
  // A newer run holds the revert only when it may BE the fix.
  const fixRunning = latest
    ? sorted.some(
        (r) =>
          r.status !== "completed" &&
          at(r.created_at) > at(latest.created_at) &&
          isFixMerge(r.head_commit?.message)
      )
    : false;
  const main = { latest, fixRunning };
  let record = null;
  if (latest && latest.conclusion !== "success" && !fixRunning)
    record = recordOf(gh, repo, latest.head_sha, log);
  const c = record?.culprits?.[0];
  const input = {
    now,
    main,
    record,
    culpritPr: null,
    onMainLine: false,
    openPrs: [],
    priorReverts: [],
    branchExists: false,
    owners: { ok: false, why: "not read" },
    token: Boolean(token),
  };
  if (record?.revertable && c?.pr) {
    input.culpritPr = prShape(gh.rest(`repos/${repo}/pulls/${c.pr}`));
    const branch = revertBranch(c.pr, c.sha);
    const owner = repo.split("/")[0];
    input.openPrs = (
      gh.rest(`repos/${repo}/pulls?state=open&per_page=100`) ?? []
    ).map(prShape);
    input.priorReverts = [
      ...(gh.rest(
        `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`
      ) ?? []),
      ...(gh.rest(
        `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`
      ) ?? []),
    ]
      .map(prShape)
      .filter((p) => REVERT_BRANCH_RE.test(p.head));
    try {
      gh.rest(`repos/${repo}/git/ref/heads/${branch}`);
      input.branchExists = true;
    } catch (e) {
      if (!/404|Not Found/i.test(e.message)) throw e;
    }
    if (record.lastGreen) {
      const l = sh("git", [
        "log",
        "--first-parent",
        "--format=%H",
        `${record.lastGreen}..${latest.head_sha}`,
      ]);
      input.onMainLine =
        l.code === 0 && l.out.split("\n").includes(String(c.sha));
      if (l.code !== 0)
        log(
          `::warning::main's first-parent line could not be read (${l.out.trim().slice(-200)})`
        );
    }
    if (!pod)
      input.owners = {
        ok: false,
        why: "the pod is not configured (SYNAP_POD_URL / SYNAP_OBS_KEY / SYNAP_POD_WORKSPACE_ID)",
      };
    else
      try {
        input.owners = { ok: true, sessions: await pod.activeSessions() };
      } catch (e) {
        input.owners = { ok: false, why: `the pod read failed: ${e.message}` };
      }
  }
  const d = revertDecision(input);
  log(
    `sweep: ${d.revert ? "REVERT" : "no revert"}: ${d.reasons.join("; ") || "all conditions hold"}`
  );
  if (d.hold && input.culpritPr)
    postOnce(
      gh,
      repo,
      input.culpritPr.number,
      HELD_MARK,
      { merge: c.sha },
      `The automatic revert of this merge is held: ${d.hold}. The bot does not revert while someone owns the fix (founder decision ${FOUNDER_DECISION}).`,
      log,
      dryRun
    );
  if (!d.revert) return d;
  if (dryRun) {
    log(
      `WOULD revert #${input.culpritPr.number} (${c.sha}) on ${revertBranch(input.culpritPr.number, c.sha)}`
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
    culpritPr: input.culpritPr,
    token,
    log,
  });
  return d;
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
  if (!REVERT_BRANCH_RE.test(branch))
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
      { merge: culprit.sha },
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
    REVERTED_MARK,
    { merge: culprit.sha },
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
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  const out = (name, value) => {
    if (env.GITHUB_OUTPUT)
      appendFileSync(
        env.GITHUB_OUTPUT,
        `${name}<<__CULPRIT__\n${value}\n__CULPRIT__\n`
      );
  };
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
      out("bisect", "true");
      out("plan", JSON.stringify(plan));
      return { plan, bisect: true };
    }
    const v = verdict({
      failing: plan.failing,
      candidates,
      attribution,
      lastGreen: plan.lastGreen,
      silentJobs: plan.silentJobs,
    });
    const pod = podClient(env, fetchImpl);
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
    const plan = JSON.parse(env.PLAN);
    const shas = plan.candidates.map((c) => c.sha);
    const filters = buildFilters(
      readFileSync(
        join(root, ".github/actions/monorepo-setup/action.yml"),
        "utf8"
      )
    );
    const kinds = new Map(plan.failing.map((f) => [f.file, f.kind]));
    const probe = makeProbe({ sh, root, log, env, filters, kinds });
    const { results, probes } = await bisect(shas, plan.bisect, probe, {
      hints: new Map(Object.entries(plan.hints ?? {})),
    });
    log(`bisect: ${probes} probe(s)`);
    const result = { bisected: Object.fromEntries(results), probes };
    out("result", JSON.stringify(result));
    return result;
  }
  if (mode === "post") {
    // The plan comes from the name job (main's finder); the bisect result is
    // checked against it. A bisect that did not finish leaves RESULT empty:
    // the verdict is then the mapping's, and says what it could not settle.
    const plan = JSON.parse(env.PLAN);
    let result = null;
    try {
      result = env.RESULT ? JSON.parse(env.RESULT) : null;
    } catch {
      log("::warning::the bisect result is not JSON: ignored");
    }
    const v = verdict({
      failing: plan.failing,
      candidates: plan.candidates,
      attribution: new Map(Object.entries(plan.attribution)),
      bisected: trustedBisect(plan, result),
      lastGreen: plan.lastGreen,
      silentJobs: plan.silentJobs,
    });
    const pod = podClient(env, fetchImpl);
    return postVerdict({ gh, pod, repo, plan, v, now, log, dryRun });
  }
  if (mode === "sweep")
    return sweep({
      gh,
      sh,
      pod: podClient(env, fetchImpl),
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
