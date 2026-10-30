#!/usr/bin/env node
/**
 * ci-changes.mjs — what a CI run must check, from what the change touched.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * Measured 2026-10-27 (400 CI runs in 22 h, pod document "Backend CI: where the
 * 2 hours per PR go"): a PR waited ~47 min in the queue and ~65 min for the
 * Full suite. Drafts, negative-control branches and docs-only PRs paid the same
 * 65 min, and every PR built and smoke-tested the Docker image (12 min) even
 * when nothing that goes into the image changed. This script decides, per run,
 * which of those it can skip. ci.yml reads its outputs.
 *
 * ── FAIL-SAFE ────────────────────────────────────────────────────────────────
 * Every output defaults to "run it". Only a positive, narrow match skips
 * anything: an unknown path, a failed `git diff` or a push to main checks
 * everything. ci.yml also runs every job when THIS job fails.
 * One exception, on purpose: the image jobs (see IMAGE_INPUTS).
 *
 * ── THREE TIERS (founder, 2026-10-29, "One trunk, three CI tiers") ──────────
 *   PR       Preflight, the Release gate, and the tests of what the change can
 *            break: the test files it reaches through the import graph, the
 *            tests that name a changed package by path, and every tripwire
 *            (scripts/ci/affected.mjs, scope "selected"), in 1 to 8 shards
 *            sized from their measured cost. Root config and the test runner
 *            run the full suite (affected.mjs ROOT_FULL). API e2e only when
 *            the API surface changed (affected.mjs API_SURFACE).
 *   main     every push runs everything; nobody waits on it.
 *   release  a pod updates only to a main commit whose post-merge run was
 *            all green (scripts/ci/release-gate-wait.mjs).
 * A required check whose suite this tier does not run still RUNS and passes
 * through an explicit "Not affected" step that writes why to the run's
 * summary; it is never skipped by its `if:` (GitHub counts a skipped job as a
 * passed required check, #441).
 *
 * ── THE MERGE QUEUE (founder, 2026-10-28: "light queue run", #428) ──────────
 * A queue entry re-checks what can break when PRs combine — the Release gate
 * (install, lint, typecheck, build, migrate, boot; the image per
 * IMAGE_INPUTS) — and takes the Full
 * suite + API e2e from the PR's OWN run, but only when that run really ran
 * them: both checks concluded `success` on the PR's head commit (since
 * 2026-10-29 that run checked the PR's tier, not everything: main's
 * post-merge run checks everything, and only an all-green one reaches a pod).
 * A skipped or neutral conclusion, a failure, a missing check or any API
 * error falls through to the tier of what the entry changes on top of the
 * main it will land on (`git diff <merge_group.base_sha>...<merge_group.
 * head_sha>`: the PR plus any entry ahead of it), on the combined tree.
 *
 * SAME TREE, NOTHING RE-RUNS (2026-10-28): #471 passed all 4 required checks
 * on its PR run, entered the queue with main unchanged, and the queue ran a
 * full ~30-min CI on a merge commit whose tree was the one already tested.
 * Every run records the commit it tested in a step name of "What changed"
 * (`Tested commit <sha>`: the jobs API returns step names). A queue entry
 * whose tree equals the tree of the commit tested by the PR run on which ALL
 * 4 required checks concluded `success` (one run; skipped, neutral or missing
 * is not success) re-runs nothing: the required checks skip, which GitHub
 * reports as passed, and the step summary names the reused run. Anything else
 * falls through to the light queue run above, then to the tier. What it
 * does not re-check: the sibling repos (control-plane-api, app-bases) at
 * main may have moved since; Preflight re-reads the one cross-repo red we
 * measured (door-tool-names) on every queue run.
 *
 * ── OUTPUTS (GITHUB_OUTPUT) ──────────────────────────────────────────────────
 *   gate          Release gate runs           false: negctl branch, docs-only
 *   image         Docker build + deploy tests false: a PR or queue entry
 *                                             touching no IMAGE_INPUTS path
 *   image_reason  image=false: why (the judge prints it beside the skip)
 *   suites        the Full suite shards run   false: draft, stack, negctl,
 *                                             docs-only, a same-tree or a
 *                                             light queue entry
 *   scope         what the shards run: "full" | "selected" | "none"
 *   shards        the shard matrix, JSON (`[1,2,3,4]`; scope=selected: 1 to
 *                 SELECTION_MAX_SHARDS, sized from the selection's measured
 *                 cost, scripts/test-ratchet-shards.mjs planSelection)
 *   shard_count   the number of shards (the job name's "k/N")
 *   selected      scope=selected: how many test files run
 *   The selection itself (which files, in which shard, under which report id)
 *   is written to SELECTION_OUT (default coverage/selection.json); ci.yml
 *   uploads it, and the shards and the judge read that one file
 *   (test-ratchet.mjs --select=).
 *   e2e           API e2e runs (the API surface changed, or everything runs)
 *   reuse         a queue entry re-runs nothing (same tree as its PR's
 *                 all-green run)
 *   negctl        a negctl/* branch           true: run "Targeted tests" only
 *   negctl_tests  the test files a negctl runs (space-separated, repo-relative)
 *   hold          why a required check reports RED instead of being skipped:
 *                 "draft" | "negctl" | "stacked" | "" (see decide())
 *   draft_hold    hold == "draft" (kept for readers of the old output)
 *   dependents    the "Dependent repos" job runs: shared types changed (or the
 *                 job's own files), so app-bases, browser and relay-app are
 *                 checked out and typechecked against this head
 *   reason        one line for the job log
 *
 * Usage (ci.yml): node scripts/ci-changes.mjs
 *   env EVENT, HEAD_REF, BASE_REF, DRAFT ("true"/"false"), BASE_SHA, HEAD_SHA
 *   merge queue: QUEUE_HEAD_REF (merge_group.head_ref), QUEUE_BASE_SHA
 *   (merge_group.base_sha), QUEUE_HEAD_SHA (merge_group.head_sha), REPO,
 *   GITHUB_TOKEN
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE,
  PACKAGE_JSON,
  baselineFiles,
  loadGraph,
  packageJsonInert,
  selectTier,
  suiteDirs,
} from "./ci/affected.mjs";
import {
  loadShardPlan,
  ownerDir,
  planSelection,
} from "./test-ratchet-shards.mjs";
import { isTripwire } from "./tripwire-discovery.mjs";
// THE test-file pattern (the import graph's): the selection, everyTest and
// the negctl tests agree on what a test file is.
import { TEST_FILE } from "./ci/import-graph.mjs";

// Paths no test, build or image reads. Narrow on purpose: tests read
// docs/decisions/*.md, skills/**/SKILL.md, CLAUDE.md and .claude/rules/*.md,
// so those are NOT here (a guard in ci-changes.tripwire.test.ts scans every
// test file for a path this list would skip).
const DOCS_ONLY = [
  /^docs\/(?!decisions\/|reference\/|architecture\/).*$/,
  /^(README|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|SECURITY-RELEASE-RUNBOOK)\.md$/,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/pull_request_template\.md$/,
];

// THE IMAGE RULE (founder, 2026-10-29, decision ffaafe15; finding 66c40812).
// The one place it is stated; ci.yml, docker-publish.yml and the Release
// gate judge point here.
//   - A pull request or a merge-queue entry runs "Release gate: Docker image"
//     and "Release gate: deploy tests" ONLY when it touches one of these
//     paths. An unknown path does NOT run them: the one exception to the
//     fail-safe above. Otherwise both jobs are skipped, and the judge accepts
//     that skip only when this decision said image=false (IMAGE_DUE).
//   - Every push (main, develop, release/**) runs both: decide() returns `all`.
//   - Every release runs both again on the commit it builds, before the
//     production approval (docker-publish.yml release-checks), and smoke-tests
//     the image it pushes. So a path this list misses is caught on main,
//     before any pod gets it.
// The list is pinned against what it is derived from
// (ci-changes.tripwire.test.ts): every COPY source, manifest and build config
// of deploy/Dockerfile; every repo path a deploy test reads ("$HERE/<path>"
// in deploy/__tests__/*.test.sh); the skill runner the image smoke runs; the
// files that define the image jobs.
const IMAGE_INPUTS = [
  /^deploy\//,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)\.dockerignore$/,
  /^docker\//,
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.npmrc)$/,
  /^(apps|packages|marketplaces)\/[^/]+\/package\.json$/,
  /^packages\/database\//,
  /^packages\/api\/tsup\.provision\.config\.ts$/,
  /^packages\/api\/src\/services\/skills\//,
  /^kratos\//,
  /^skills\//,
  /^(synap|install\.sh)$/,
  /^scripts\/(skill-runner-sandbox-smoke|check-migrations-forward-only|release-min-from)\.mjs$/,
  /^scripts\/ci\/(image-smoke|deploy-tests)\.sh$/,
  /^\.github\/workflows\/(ci|docker-publish)\.yml$/,
  // Read by the deploy tests by path (kratos-recovery-config,
  // kratos-registration-gate, pod-version-reported).
  /^apps\/api\/src\/(index\.ts|routers\/provision\.ts|webhooks\/kratos[^/]*\.ts)$/,
  /^apps\/pod-admin\/app\/(recovery|settings\/security)\/page\.tsx$/,
];

// Paths the other repos link by source (app-bases, browser and relay-app read
// @synap-core/types, api-types and markdown-core from this checkout; #372 broke
// an app repo with backend CI green), plus the job's own files so a change to
// the job runs it.
const SHARED_FOR_DEPENDENTS = [
  /^packages\/(types|api-types|markdown-core)\//,
  /^scripts\/ci\/dependent-root\//,
  /^\.github\/workflows\/ci\.yml$/,
];
export const touchesDependents = (files) =>
  files.some((f) => SHARED_FOR_DEPENDENTS.some((re) => re.test(f)));

export const isDocsOnly = (path) => DOCS_ONLY.some((re) => re.test(path));
export const isImageInput = (path) => IMAGE_INPUTS.some((re) => re.test(path));
/** Does this change need the image jobs? `files` null (unknown): yes. */
export const needsImage = (files) => !files || files.some(isImageInput);

/** The PR a merge-queue branch tests: `refs/heads/gh-readonly-queue/main/pr-402-<sha>` → 402. */
export function queuePrNumber(queueHeadRef) {
  const m = /gh-readonly-queue\/[^/]+\/pr-(\d+)-/.exec(queueHeadRef ?? "");
  return m ? Number(m[1]) : null;
}

/** The suites a light queue entry takes from the PR's own run (#428). */
export const QUEUE_TRUSTED_CHECKS = ["Full suite", "API e2e"];

/**
 * The check run that decides `name` on a commit: the newest one (highest id),
 * as GitHub reads a required check, or null. A commit run twice (a flake
 * re-run, the merge bot's draft/ready toggle for a victim of a red main)
 * keeps the first run's red beside the second's green, and `filter=latest`
 * returns both (one per check suite). Requiring every one to pass made each
 * such PR re-run its suites in the queue though GitHub counted it green
 * (29 Oct: #485, a failure at 00:15 and a success at 01:58 on one head).
 */
function decidingRun(checkRuns, name) {
  const runs = checkRuns.filter((r) => r?.name === name);
  if (runs.length === 0) return null;
  return runs.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
}

/**
 * Did the PR's own run REALLY pass the suites? `checkRuns` = the latest check
 * runs of the PR's head commit ({ id, name, status, conclusion }). Only
 * `completed` + `success` counts: `skipped` and `neutral` count as green to
 * GitHub, and a draft run reports the suites red ("suites not run").
 */
export function suitesPassed(checkRuns) {
  if (!Array.isArray(checkRuns)) return false;
  return QUEUE_TRUSTED_CHECKS.every((name) => {
    const r = decidingRun(checkRuns, name);
    return r?.status === "completed" && r.conclusion === "success";
  });
}

/**
 * The checks a same-tree queue entry takes whole from the PR's own run: the
 * 4 required checks (scripts/apply-main-protection.sh REQUIRED_CHECKS; the
 * tripwire pins them equal).
 */
export const QUEUE_REUSE_CHECKS = [
  "Release gate",
  "Full suite",
  "API e2e",
  "Reference docs are current",
];

/** The "What changed" step that names the commit a run tested. */
export const TESTED_STEP = /^Tested commit ([0-9a-f]{40})$/;

/**
 * The workflow run id on which EVERY required check concluded `success`, or
 * null. `checkRuns` = the latest check runs of the PR's head for those names
 * ({ id, name, status, conclusion, details_url }); each name is decided by
 * its newest run (decidingRun). All of them must come from ONE
 * run (its id read from details_url, `/actions/runs/<id>/`): that run tested
 * one commit, the one its "What changed" step names.
 */
export function reusableRun(checkRuns) {
  if (!Array.isArray(checkRuns)) return null;
  const ids = new Set();
  for (const name of QUEUE_REUSE_CHECKS) {
    const r = decidingRun(checkRuns, name);
    if (!r) return null;
    if (r.status !== "completed" || r.conclusion !== "success") return null;
    const id = /\/actions\/runs\/(\d+)\//.exec(r.details_url ?? "")?.[1];
    if (!id) return null;
    ids.add(id);
  }
  return ids.size === 1 ? Number([...ids][0]) : null;
}

/**
 * The decision for one run. Pure: `files` is the changed path list, or null
 * when it could not be read (then everything runs).
 * `siblingTests(path)` lists test files beside a changed source file.
 * `tier(files)` is scripts/ci/affected.mjs selectTier over this checkout's
 * graph, or null when the graph could not be read (then the full suite runs).
 * `queue` is a merge-queue entry's evidence ({ pr, headSha, suitesPassed,
 * reuse: { runId, testedCommit, testedTree, queueTree } | null }), or null.
 */
// Bases a pull request may land on through the ruleset. Any other base is a
// stack: nothing checks it before it reaches main as one big PR (#372).
const LANDING_BASES = ["main", "develop"];

export function decide({
  event,
  headRef,
  baseRef,
  draft,
  files,
  siblingTests,
  tier = null,
  queue = null,
}) {
  const all = {
    gate: true,
    image: true,
    suites: true,
    scope: "full",
    selection: null,
    e2e: true,
    why: [],
    negctl: false,
    negctlTests: [],
    draftHold: false,
    hold: "",
    dependents: false,
    imageWhy: "",
  };
  const nothing = {
    ...all,
    gate: false,
    image: false,
    suites: false,
    scope: "none",
    e2e: false,
  };
  const reuse = queue?.reuse;
  if (
    event === "merge_group" &&
    reuse?.runId &&
    typeof reuse.testedTree === "string" &&
    /^[0-9a-f]{40}$/.test(reuse.testedTree) &&
    reuse.testedTree === reuse.queueTree
  )
    return {
      ...nothing,
      reuse: true,
      reason: `merge queue: tree ${reuse.testedTree.slice(0, 9)} is the tree #${queue.pr}'s run ${reuse.runId} tested (commit ${String(reuse.testedCommit).slice(0, 9)}), where all ${QUEUE_REUSE_CHECKS.length} required checks passed; nothing re-runs`,
    };
  if (event !== "pull_request" && event !== "merge_group")
    return { ...all, reason: `${event}: every check runs (tier 2: main)` };
  if (!files)
    return {
      ...all,
      dependents: event === "pull_request",
      reason: "changed files unknown: every check runs",
    };

  const docsOnly = files.length > 0 && files.every(isDocsOnly);
  // The image jobs: IMAGE_INPUTS.
  const image = needsImage(files);
  const imageWhy = image
    ? ""
    : "no IMAGE_INPUTS path changed (scripts/ci-changes.mjs): Docker image and deploy tests not affected; every push to main and every release run them";
  // The tier: what the change can break (scripts/ci/affected.mjs). No graph
  // (it failed to load) is the full suite, never a guess.
  const pick = () => {
    if (docsOnly) return { scope: "none", tests: [], e2e: false, why: [] };
    // Docs-only paths read by no test (DOCS_ONLY) never widen the tier.
    const t = tier ? tier(files.filter((f) => !isDocsOnly(f))) : null;
    return (
      t ?? {
        scope: "full",
        tests: [],
        e2e: true,
        why: ["full suite: the dependency graph could not be read"],
      }
    );
  };
  const tierFields = (t) => ({
    suites: t.scope !== "none",
    scope: t.scope,
    selection: t.selection ?? null,
    e2e: t.e2e,
    why: t.why,
  });

  // The light queue run (#428): the PR's own Full suite and API e2e passed,
  // so the entry re-checks the Release gate. The two suite checks pass
  // through their "Not affected" steps, which name this reason.
  if (event === "merge_group" && queue?.suitesPassed === true)
    return {
      ...all,
      image,
      imageWhy,
      suites: false,
      scope: "none",
      e2e: false,
      reason: [
        `merge queue: #${queue.pr}'s own Full suite and API e2e passed on ${String(queue.headSha).slice(0, 9)}; this run re-checks the Release gate`,
        imageWhy,
      ]
        .filter(Boolean)
        .join("; "),
    };

  // A queue entry whose PR run did not pass both: the Release gate and the
  // FULL suite on the combined tree (rare: the PR's own suites were red,
  // skipped or unreadable, so nothing vouches for a selection). Docs only
  // still runs no suite.
  if (event === "merge_group") {
    const t = docsOnly
      ? pick()
      : {
          scope: "full",
          tests: [],
          e2e: true,
          why: [
            "full suite: the PR's own Full suite and API e2e did not both pass, so the entry is checked whole",
          ],
        };
    return {
      ...all,
      image,
      imageWhy,
      ...tierFields(t),
      reason: [
        `merge queue${queue?.pr ? ` (#${queue.pr})` : ""}: the Release gate, and ${tierText(t)} on the tree it will land`,
        imageWhy,
      ]
        .filter(Boolean)
        .join("; "),
    };
  }

  if (headRef?.startsWith("negctl/")) {
    const tests = new Set(files.filter((f) => TEST_FILE.test(f)));
    for (const f of files)
      if (!TEST_FILE.test(f)) for (const t of siblingTests(f)) tests.add(t);
    // A negctl branch never merges. Its skipped Release gate, suites and
    // Reference docs would read as PASSED required checks (a job skipped by its
    // `if:` reports success), so a negctl PR to main could merge on green
    // skips: only its title said "NEVER MERGE". Every required check holds red
    // instead; "Targeted tests" still runs its files.
    return {
      ...nothing,
      negctl: true,
      negctlTests: [...tests].sort(),
      hold: "negctl",
      reason: `negctl branch: only its ${tests.size} test file(s) run; every required check reports red (a negctl branch never merges)`,
    };
  }

  if (docsOnly)
    return {
      ...nothing,
      reason: `docs only (${files.length} file(s)): no check needs to run`,
    };

  // A base other than main/develop is a stack. It gets the Release gate (a
  // typecheck and build, so a stack is not entirely unchecked), and the suites
  // hold red: they run when the PR is retargeted to main. Docs-only returned
  // above. A stacked draft holds as "stacked".
  const stacked = !!baseRef && !LANDING_BASES.includes(baseRef);
  const hold = stacked ? "stacked" : draft ? "draft" : "";
  const t = hold ? null : pick();
  return {
    ...all,
    image,
    imageWhy,
    ...(t
      ? tierFields(t)
      : { suites: false, scope: "none", e2e: false, why: [] }),
    // A draft skips the suites, and GitHub counts a job skipped by its `if:`
    // as a PASSED required check. backend#382 and #394 (28 Oct) merged the
    // moment they were marked ready, on the draft run's skipped "Full suite"
    // and "API e2e", before the ready run reported. So on a draft those two
    // jobs run and fail ("suites not run: draft"): the latest result of each
    // required check on the head commit is red until a ready run replaces it.
    // The suites themselves still do not run. Docs-only and negctl return
    // above: their skip does not change when the PR is marked ready.
    draftHold: hold === "draft",
    hold,
    dependents: touchesDependents(files),
    reason: [
      stacked
        ? `base is ${baseRef}, not main: Release gate only; Full suite and API e2e report red (suites not run) until the PR targets main`
        : draft
          ? "draft: Release gate only; Full suite and API e2e report red (suites not run) until it is marked ready"
          : `the Release gate, and ${tierText(t)}`,
      imageWhy,
    ]
      .filter(Boolean)
      .join("; "),
  };
}

/** One line for a tier: what the Full suite and API e2e run, and why. */
export function tierText(t) {
  const suite =
    t.scope === "full"
      ? "the full suite"
      : t.scope === "none"
        ? "no test suite"
        : `${t.tests.length} selected test file(s), every tripwire included${t.selection ? `, in ${t.selection.shards} shard(s)` : ""}`;
  return `${suite}${t.why?.length ? ` [${t.why.join("; ")}]` : ""}; API e2e ${t.e2e ? "runs" : "not affected (no API surface path changed)"}`;
}

/**
 * The run's step summary: what each required check does in this run, and
 * why. The judges whose suite does not run pass by pointing at it.
 */
export function summary(d, files) {
  const rows = [
    [
      "Release gate",
      d.hold === "negctl"
        ? "red (negctl never merges)"
        : d.reuse
          ? "reused"
          : d.gate
            ? "runs"
            : "not affected",
    ],
    [
      "Full suite",
      d.hold
        ? `red (${d.hold}: suites not run)`
        : d.reuse
          ? "reused"
          : d.scope === "full"
            ? `runs: everything${d.selection ? ` (${d.selection.tests.length} test files in ${d.selection.shards} cost-sized shard(s))` : " (4 shards)"}`
            : d.scope === "selected"
              ? `runs: ${d.selection?.tests.length ?? "?"} selected test file(s) (every tripwire included) in ${d.selection?.shards ?? "?"} shard(s)`
              : "not affected",
    ],
    [
      "API e2e",
      d.hold
        ? `red (${d.hold}: suites not run)`
        : d.reuse
          ? "reused"
          : d.e2e
            ? "runs"
            : "not affected",
    ],
    [
      "Docker image + deploy tests",
      d.gate && d.image
        ? "runs"
        : d.gate
          ? "skipped: not affected (IMAGE_INPUTS)"
          : "not run (the Release gate does not run)",
    ],
  ];
  return [
    "### What this run checks (scripts/ci-changes.mjs)",
    "",
    "| check | this run |",
    "|---|---|",
    ...rows.map(([c, v]) => `| ${c} | ${String(v).replace(/\|/g, "\\|")} |`),
    "",
    `Why: ${d.reason}.`,
    ...(d.why?.length ? ["", ...d.why.map((w) => `- ${w}`)] : []),
    ...(d.selection
      ? [
          "",
          `Shards: ${d.selection.shards}, predicted test seconds per shard ${d.selection.predictedSeconds.join(" / ")} (budget ${d.selection.budgetSeconds} s; scripts/test-ratchet-shards.mjs planSelection).`,
          ...(d.selection.dropped.length
            ? [
                "",
                `${d.selection.dropped.length} selected file(s) run nowhere, on main either (no \`vitest run\` suite in their package): ${d.selection.dropped.slice(0, 10).join(", ")}`,
              ]
            : []),
          "",
          "<details><summary>The selected test files that are not tripwires</summary>",
          "",
          ...d.selection.tests
            .filter((f) => !isTripwire(f))
            .map((f) => `- \`${f}\``),
          "",
          "</details>",
        ]
      : []),
    ...(files
      ? ["", `${files.length} changed file(s).`]
      : ["", "Changed files unknown."]),
    "",
  ].join("\n");
}

/**
 * The paths a change touched, or null when git cannot say. `--no-renames`: a
 * rename lists its OLD path too, so the tests that still read the old path are
 * selected (a rename detected by git would hide it).
 */
export function changedFiles(base, head, cwd = undefined) {
  if (!base || !head) return null;
  try {
    return execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", `${base}...${head}`],
      { encoding: "utf8", cwd }
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The changed package.json files whose diff touches only fields that decide
 * nothing about collection (affected.mjs INERT_PACKAGE_KEYS). `read(path)`
 * returns [before, after] texts (null for a side that does not exist).
 */
export function collectionInert(files, read) {
  return files.filter((f) => {
    if (!PACKAGE_JSON.test(f)) return false;
    const [before, after] = read(f);
    return packageJsonInert(before, after);
  });
}

/**
 * The paths a change ADDS (`base...head`, renames as delete + add), or [] when
 * git cannot say. The judge is red when vitest collects one of them nowhere.
 */
export function addedFiles(base, head, cwd = undefined) {
  if (!base || !head) return [];
  try {
    return execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "--no-renames",
        "--diff-filter=A",
        `${base}...${head}`,
      ],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] }
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A file at a commit, or null (absent, or git cannot say). */
function showAt(ref, path, cwd) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * [before, after] of a path over `base...head` (the merge base, as
 * changedFiles diffs), or [null, null] when the merge base cannot be read.
 */
export function sidesOf(base, head, cwd = undefined) {
  let mb = null;
  try {
    if (base && head)
      mb = execFileSync("git", ["merge-base", base, head], {
        encoding: "utf8",
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
  } catch {
    mb = null;
  }
  return (path) =>
    mb ? [showAt(mb, path, cwd), showAt(head, path, cwd)] : [null, null];
}

// `src/x/foo.ts` → `src/x/foo.test.ts`, `src/x/foo.*.test.ts` that exist.
function siblingTests(path) {
  const dir = dirname(path);
  const stem = basename(path).replace(/\.(ts|tsx|mts|mjs|js)$/, "");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${stem}.`) && TEST_FILE.test(n))
    .map((n) => join(dir, n));
}

// The queue entry's PR and its own check runs, or null (then everything runs).
async function queueEvidence() {
  const pr = queuePrNumber(process.env.QUEUE_HEAD_REF);
  const repo = process.env.REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!pr || !repo || !token) return null;
  const get = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
  try {
    const headSha = (await get(`/pulls/${pr}`)).head.sha;
    const checkRuns = [];
    for (const name of QUEUE_REUSE_CHECKS) {
      const q = `?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`;
      checkRuns.push(
        ...(await get(`/commits/${headSha}/check-runs${q}`)).check_runs
      );
    }
    return {
      pr,
      headSha,
      suitesPassed: suitesPassed(checkRuns),
      reuse: await reuseEvidence(get, checkRuns),
    };
  } catch (err) {
    console.log(
      `merge queue: could not read #${pr}'s own checks (${err.message}); no reuse`
    );
    return null;
  }
}

// The PR run to reuse and the two trees to compare, or null (a failed read
// is no reuse, never a guess).
async function reuseEvidence(get, checkRuns) {
  const runId = reusableRun(checkRuns);
  const queueSha = process.env.QUEUE_HEAD_SHA;
  if (!runId || !queueSha) return null;
  try {
    const jobs = (await get(`/actions/runs/${runId}/jobs?per_page=100`)).jobs;
    const testedCommit = jobs
      .find((j) => j.name === "What changed")
      ?.steps?.map((st) => TESTED_STEP.exec(st.name)?.[1])
      .find(Boolean);
    if (!testedCommit) {
      console.log(
        `merge queue: run ${runId} names no tested commit (it predates the "Tested commit" step); no reuse`
      );
      return null;
    }
    const testedTree = (await get(`/git/commits/${testedCommit}`)).tree.sha;
    const queueTree = (await get(`/git/commits/${queueSha}`)).tree.sha;
    return { runId, testedCommit, testedTree, queueTree };
  } catch (err) {
    console.log(
      `merge queue: could not compare trees (${err.message}); no reuse`
    );
    return null;
  }
}

// The files the known-red baseline names at a commit ([] when unreadable).
function baselineAt(sha) {
  if (!sha) return [];
  try {
    return baselineFiles(
      execFileSync("git", ["show", `${sha}:${BASELINE}`], { encoding: "utf8" })
    );
  } catch {
    return [];
  }
}

// The tier function over this checkout's graph, or null when the graph cannot
// be read (decide() then runs the full suite on the 4-shard plan). A selection
// comes with its shard plan (scripts/test-ratchet-shards.mjs planSelection).
// So does a PR's FULL tier (lead decision, 29 Oct): every test file, planned
// by cost in up to 8 shards, judged with the full mode's floors (`full`).
// Main pushes and the merge queue never reach this function: they keep the
// 4-shard plan.
function tierOfCheckout(baseSha, headSha) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const g = loadGraph(root, isTripwire);
    const suites = suiteDirs(root);
    const countByDir = {};
    for (const f of g.imports.files)
      if (TEST_FILE.test(f))
        countByDir[ownerDir(f)] = (countByDir[ownerDir(f)] ?? 0) + 1;
    const plan = loadShardPlan();
    const baseBaseline = baselineAt(baseSha);
    const everyTest = g.imports.files.filter((f) => TEST_FILE.test(f));
    const sides = sidesOf(baseSha, headSha);
    const added = addedFiles(baseSha, headSha).filter((f) => TEST_FILE.test(f));
    return (files) =>
      withPlan(
        selectTier(files, g, {
          baseBaseline,
          collectionInert: collectionInert(files, sides),
        }),
        {
          everyTest,
          suiteDirs: suites,
          plan,
          countByDir,
          added,
        }
      );
  } catch (err) {
    console.log(`dependency graph unreadable (${err.message}): full suite`);
    return null;
  }
}

/**
 * A PR tier with its shard plan: a selection plans its files; the full tier
 * plans `everyTest` (marked `full`: the judge adds the 2,000-file floor),
 * unless it is a COMMITTED_PLAN change. `ctx` = { everyTest, suiteDirs, plan,
 * countByDir, added (the test files the PR adds) }.
 */
export function withPlan(t, ctx) {
  if (t.scope !== "selected" && t.scope !== "full") return t;
  // A full tier a cost-sized plan cannot vouch for (affected.mjs
  // COMMITTED_PLAN: the runner, the selector, ci.yml, what vitest collects)
  // gets no plan: the shards run the committed 4-shard plan in the full mode,
  // with its floors.
  if (t.scope === "full" && t.committedPlan) return t;
  const full = t.scope === "full";
  return {
    ...t,
    selection: planSelection({
      tests: full ? ctx.everyTest : t.tests,
      suiteDirs: ctx.suiteDirs,
      isTripwire,
      plan: ctx.plan,
      countByDir: ctx.countByDir,
      full,
      added: ctx.added ?? [],
    }),
  };
}

/**
 * The shard matrix of a decision: a selection's own count (a PR's selected or
 * full tier), else the committed plan's 4 (main, the merge queue, fail-safe).
 */
export function shardMatrix(d) {
  const n = d.selection ? d.selection.shards : 4;
  return Array.from({ length: n }, (_, i) => i + 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const event = process.env.EVENT;
  const queue = event === "merge_group" ? await queueEvidence() : null;
  const files =
    event === "merge_group"
      ? changedFiles(process.env.QUEUE_BASE_SHA, process.env.QUEUE_HEAD_SHA)
      : changedFiles(process.env.BASE_SHA, process.env.HEAD_SHA);
  const d = decide({
    event,
    headRef: process.env.HEAD_REF,
    baseRef: process.env.BASE_REF,
    draft: process.env.DRAFT === "true",
    files,
    siblingTests,
    tier: tierOfCheckout(
      event === "merge_group"
        ? process.env.QUEUE_BASE_SHA
        : process.env.BASE_SHA,
      event === "merge_group"
        ? process.env.QUEUE_HEAD_SHA
        : process.env.HEAD_SHA
    ),
    queue,
  });
  // A selection reaches the shards and the judge as one file (ci.yml uploads
  // it); without it they fail, they never run something else.
  if (d.selection) {
    const outFile = resolve(
      process.env.SELECTION_OUT ?? "coverage/selection.json"
    );
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(d.selection, null, 1)}\n`);
  }
  const out = [
    `gate=${d.gate}`,
    `image=${d.image}`,
    `image_reason=${d.imageWhy}`,
    `suites=${d.suites}`,
    `scope=${d.scope}`,
    `shards=${JSON.stringify(shardMatrix(d))}`,
    `shard_count=${shardMatrix(d).length}`,
    `selected=${d.selection?.tests.length ?? ""}`,
    `select=${!!d.selection}`,
    `e2e=${d.e2e}`,
    `negctl=${d.negctl}`,
    `negctl_tests=${d.negctlTests.join(" ")}`,
    `draft_hold=${d.draftHold}`,
    `hold=${d.hold}`,
    `dependents=${d.dependents}`,
    `reuse=${d.reuse === true}`,
    `reason=${d.reason}`,
  ];
  console.log(out.join("\n"));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${out.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      d.reuse
        ? `### Merge queue: verdict reused\n\n${d.reason}.\n\nReused run: https://github.com/${process.env.REPO}/actions/runs/${queue?.reuse?.runId}\n`
        : summary(d, files)
    );
}
