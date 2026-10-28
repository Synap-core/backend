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
 *
 * ── THE MERGE QUEUE (founder, 2026-10-28: "light queue run") ─────────────────
 * A queue entry re-checks what can break when PRs combine — the Release gate
 * (install, lint, typecheck, build, migrate, boot, image) — and takes the Full
 * suite + API e2e from the PR's OWN run, but only when that run really ran
 * them: both checks concluded `success` on the PR's head commit. A skipped or
 * neutral conclusion (a draft run skips the suites, and GitHub counts a skip
 * as green), a failure, a missing check or any API error runs everything, as
 * before.
 *
 * ── OUTPUTS (GITHUB_OUTPUT) ──────────────────────────────────────────────────
 *   gate          Release gate runs           false: negctl branch, docs-only
 *   image         Docker build + deploy tests false: only image-neutral paths
 *   suites        Full suite + API e2e run    false: draft, negctl, docs-only,
 *                                             a queue entry whose PR's own
 *                                             suites passed on its head
 *   negctl        a negctl/* branch           true: run "Targeted tests" only
 *   negctl_tests  the test files a negctl runs (space-separated, repo-relative)
 *   reason        one line for the job log
 *
 * Usage (ci.yml): node scripts/ci-changes.mjs
 *   env EVENT, HEAD_REF, DRAFT ("true"/"false"), BASE_SHA, HEAD_SHA
 *   merge queue: QUEUE_HEAD_REF (merge_group.head_ref), REPO, GITHUB_TOKEN
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

// Paths that cannot change what the Docker image is or what the deploy tests
// read: application source compiled by `pnpm build` (the gate's Build step
// already fails a broken build) and test files. Everything else — deploy/,
// Dockerfile, package.json, the lockfile, packages/database (its migrations
// ship in the image and deploy tests read them), the skill runner the image
// smoke runs — keeps the image steps on.
const IMAGE_NEUTRAL = [
  /^(apps|packages)\/(?!database\/)[^/]+\/src\/(?!services\/skills\/)/,
  /\.test\.(ts|tsx|mts|mjs|js)$/,
  /\/__tests__\//,
  /\/__tripwires__\//,
];

const TEST_FILE = /\.test\.(ts|tsx|mts|mjs|js)$/;

export const isDocsOnly = (path) => DOCS_ONLY.some((re) => re.test(path));
export const isImageNeutral = (path) =>
  isDocsOnly(path) || IMAGE_NEUTRAL.some((re) => re.test(path));

/** The PR a merge-queue branch tests: `refs/heads/gh-readonly-queue/main/pr-402-<sha>` → 402. */
export function queuePrNumber(queueHeadRef) {
  const m = /gh-readonly-queue\/[^/]+\/pr-(\d+)-/.exec(queueHeadRef ?? "");
  return m ? Number(m[1]) : null;
}

/** The suites a queue entry may take from the PR's own run. */
export const QUEUE_TRUSTED_CHECKS = ["Full suite", "API e2e"];

/**
 * Did the PR's own run REALLY pass the suites? `checkRuns` = the latest check
 * runs of the PR's head commit ({ name, status, conclusion }). Only
 * `completed` + `success` counts: `skipped` and `neutral` count as green to
 * GitHub, and a draft run reports the suites as skipped.
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
 * The decision for one run. Pure: `files` is the changed path list, or null
 * when it could not be read (then everything runs).
 * `siblingTests(path)` lists test files beside a changed source file.
 * `queue` is a merge-queue entry's evidence ({ pr, headSha, suitesPassed }),
 * or null.
 */
export function decide({
  event,
  headRef,
  draft,
  files,
  siblingTests,
  queue = null,
}) {
  const all = {
    gate: true,
    image: true,
    suites: true,
    negctl: false,
    negctlTests: [],
  };
  if (event === "merge_group" && queue?.suitesPassed === true)
    return {
      ...all,
      suites: false,
      reason: `merge queue: #${queue.pr}'s own Full suite and API e2e passed on ${String(queue.headSha).slice(0, 9)}; this run re-checks the Release gate`,
    };
  if (event !== "pull_request")
    return { ...all, reason: `${event}: every check runs` };
  if (!files)
    return { ...all, reason: "changed files unknown: every check runs" };

  if (headRef?.startsWith("negctl/")) {
    const tests = new Set(files.filter((f) => TEST_FILE.test(f)));
    for (const f of files)
      if (!TEST_FILE.test(f)) for (const t of siblingTests(f)) tests.add(t);
    return {
      gate: false,
      image: false,
      suites: false,
      negctl: true,
      negctlTests: [...tests].sort(),
      reason: `negctl branch: only its ${tests.size} test file(s) run`,
    };
  }

  if (files.length > 0 && files.every(isDocsOnly))
    return {
      gate: false,
      image: false,
      suites: false,
      negctl: false,
      negctlTests: [],
      reason: `docs only (${files.length} file(s)): no check needs to run`,
    };

  const image = !files.every(isImageNeutral);
  return {
    gate: true,
    image,
    suites: !draft,
    negctl: false,
    negctlTests: [],
    reason:
      [
        draft
          ? "draft: Release gate only (suites start when marked ready)"
          : "",
        image
          ? ""
          : "no image-relevant path: Docker build and deploy tests skipped",
      ]
        .filter(Boolean)
        .join("; ") || "every check runs",
  };
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
    for (const name of QUEUE_TRUSTED_CHECKS) {
      const q = `?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`;
      checkRuns.push(
        ...(await get(`/commits/${headSha}/check-runs${q}`)).check_runs
      );
    }
    return { pr, headSha, suitesPassed: suitesPassed(checkRuns) };
  } catch (err) {
    console.log(
      `merge queue: could not read #${pr}'s own checks (${err.message}); every check runs`
    );
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = decide({
    event: process.env.EVENT,
    headRef: process.env.HEAD_REF,
    draft: process.env.DRAFT === "true",
    files: changedFiles(process.env.BASE_SHA, process.env.HEAD_SHA),
    siblingTests,
    queue: process.env.EVENT === "merge_group" ? await queueEvidence() : null,
  });
  const out = [
    `gate=${d.gate}`,
    `image=${d.image}`,
    `suites=${d.suites}`,
    `negctl=${d.negctl}`,
    `negctl_tests=${d.negctlTests.join(" ")}`,
    `reason=${d.reason}`,
  ];
  console.log(out.join("\n"));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${out.join("\n")}\n`);
}
