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
 * ONE exception, on purpose (founder, 2026-10-29, decision ffaafe15): on a
 * pull request or a queue entry the Docker image and the deploy tests run
 * only for a positive match of IMAGE_INPUTS, so an unknown path does NOT run
 * them there. They are not lost: every push to main runs them, and a release
 * runs them again before it is built (docker-publish.yml).
 *
 * ── THREE TIERS (founder, 2026-10-29, "One trunk, three CI tiers") ──────────
 *   PR       Preflight, the Release gate, and the tests of what the change can
 *            break: the touched packages, every workspace package that
 *            depends on them, the test files of other packages that read them
 *            by path, and every tripwire (scripts/ci/affected.mjs). A change
 *            to shared or core code (outside a package, packages/database,
 *            types, core) runs the full suite. API e2e only when the API
 *            surface changed (affected.mjs API_SURFACE).
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
 * (install, lint, typecheck, build, migrate, boot; the image only when the
 * entry touches IMAGE_INPUTS, since 2026-10-29) — and takes the Full
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
 *   image_reason  image=false: why, for the jobs' "Not affected" step
 *   suites        the Full suite shards run   false: draft, stack, negctl,
 *                                             docs-only, a same-tree or a
 *                                             light queue entry
 *   scope         what the shards run: "full" | "affected" | "none"
 *   affected      scope=affected: the package dirs whose whole suite runs,
 *                 comma-separated (test-ratchet.mjs --affected=)
 *   also          scope=affected: test files of other packages that read an
 *                 affected package by path, comma-separated (--also=)
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
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph, selectTier } from "./ci/affected.mjs";
import { isTripwire } from "./tripwire-discovery.mjs";

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

// What the Docker image and the deploy tests are made of (founder,
// 2026-10-29, decision ffaafe15, finding 66c40812: "image checks move to the
// nightly"). A pull request or a merge-queue entry builds and smoke-tests the
// image ("Release gate: Docker image") and runs the deploy tests ("Release
// gate: deploy tests") ONLY when it touches one of these paths. A push to
// main, develop or a release branch always runs both (decide() returns
// `all`), and every release re-runs them before it is built
// (docker-publish.yml, job release-checks, and the image smoke in
// build-and-push-backend-api), so a path this list misses is caught on main,
// before any pod gets it. Until 2026-10-29 the list was the other way round
// (IMAGE_NEUTRAL: application source and tests skipped, everything else ran
// the image), which ran the image for a CI script, a README or a tsconfig.
// Derived from, and pinned against (ci-changes.tripwire.test.ts):
//   - deploy/Dockerfile: every COPY source (the lockfile, the workspace and
//     turbo manifests, kratos/, the migrations, skills/), the manifests stage
//     (every workspace package.json) and the tsup provision config it builds;
//   - the image smoke (scripts/ci/image-smoke.sh): the skill runner and its
//     sandbox smoke script;
//   - every repo path a deploy test reads ("$HERE/<path>" in
//     deploy/__tests__/*.test.sh), derived by the tripwire;
//   - the files that define the image jobs themselves (ci.yml, the
//     docker-publish workflow, the two scripts the jobs run).
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

const TEST_FILE = /\.test\.(ts|tsx|mts|mjs|js)$/;

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
 * Did the PR's own run REALLY pass the suites? `checkRuns` = the latest check
 * runs of the PR's head commit ({ name, status, conclusion }). Only
 * `completed` + `success` counts: `skipped` and `neutral` count as green to
 * GitHub, and a draft run reports the suites red ("suites not run").
 */
export function suitesPassed(checkRuns) {
  if (!Array.isArray(checkRuns)) return false;
  return QUEUE_TRUSTED_CHECKS.every((name) => {
    const runs = checkRuns.filter((r) => r?.name === name);
    return (
      runs.length > 0 &&
      runs.every((r) => r.status === "completed" && r.conclusion === "success")
    );
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
 * ({ name, status, conclusion, details_url }). All of them must come from ONE
 * run (its id read from details_url, `/actions/runs/<id>/`): that run tested
 * one commit, the one its "What changed" step names.
 */
export function reusableRun(checkRuns) {
  if (!Array.isArray(checkRuns)) return null;
  const ids = new Set();
  for (const name of QUEUE_REUSE_CHECKS) {
    const runs = checkRuns.filter((r) => r?.name === name);
    if (runs.length === 0) return null;
    for (const r of runs) {
      if (r.status !== "completed" || r.conclusion !== "success") return null;
      const id = /\/actions\/runs\/(\d+)\//.exec(r.details_url ?? "")?.[1];
      if (!id) return null;
      ids.add(id);
    }
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
    affected: [],
    also: [],
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
  // The image jobs: only when the change touches what the image or the
  // deploy tests are made of (IMAGE_INPUTS). Their jobs still RUN and pass
  // through a "Not affected" step that names this line (ci.yml).
  const image = needsImage(files);
  const imageWhy = image
    ? ""
    : "no path the image or the deploy tests are made of changed (scripts/ci-changes.mjs IMAGE_INPUTS): Docker image and deploy tests not affected; main's post-merge run and every release run them";
  // The tier: what the change can break (scripts/ci/affected.mjs). No graph
  // (it failed to load) is the full suite, never a guess.
  const pick = () => {
    if (docsOnly)
      return { scope: "none", dirs: [], tests: [], e2e: false, why: [] };
    // Docs-only paths read by no test (DOCS_ONLY) never widen the tier.
    const t = tier ? tier(files.filter((f) => !isDocsOnly(f))) : null;
    return (
      t ?? {
        scope: "full",
        dirs: [],
        tests: [],
        e2e: true,
        why: ["full suite: the dependency graph could not be read"],
      }
    );
  };
  const tierFields = (t) => ({
    suites: t.scope !== "none",
    scope: t.scope,
    affected: t.dirs,
    also: t.tests,
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

  // A queue entry whose PR run did not pass both: the Release gate, and the
  // tier of what it changes on top of the main it lands on, run on the
  // combined tree.
  if (event === "merge_group") {
    const t = pick();
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
        : `the suites of ${t.dirs.length} package(s) (${t.dirs.join(", ")})${t.tests.length ? `, ${t.tests.length} test file(s) of other packages that read them` : ""} and every tripwire`;
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
            ? "runs: everything"
            : d.scope === "affected"
              ? `runs: ${d.affected.join(", ")}${d.also.length ? ` + ${d.also.length} file(s) of other packages` : ""} + every tripwire`
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
          ? "not affected (main's post-merge run and every release run them)"
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
    ...(d.also?.length
      ? [
          "",
          "<details><summary>Test files of other packages that run</summary>",
          "",
          ...d.also.map((f) => `- \`${f}\``),
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

function changedFiles(base, head) {
  if (!base || !head) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
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

// The tier function over this checkout's graph, or null when the graph cannot
// be read (decide() then runs the full suite).
function tierOfCheckout() {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const g = loadGraph(root, isTripwire);
    return (files) => selectTier(files, g);
  } catch (err) {
    console.log(`dependency graph unreadable (${err.message}): full suite`);
    return null;
  }
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
    tier: tierOfCheckout(),
    queue,
  });
  const out = [
    `gate=${d.gate}`,
    `image=${d.image}`,
    `image_reason=${d.imageWhy}`,
    `suites=${d.suites}`,
    `scope=${d.scope}`,
    `affected=${d.affected.join(",")}`,
    `also=${d.also.join(",")}`,
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
