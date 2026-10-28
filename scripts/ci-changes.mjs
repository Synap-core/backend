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
 * anything: an unknown path, a failed `git diff`, a push to main or a merge
 * queue run checks everything. ci.yml also runs every job when THIS job fails.
 *
 * ── OUTPUTS (GITHUB_OUTPUT) ──────────────────────────────────────────────────
 *   gate          Release gate runs           false: negctl branch, docs-only
 *   image         Docker build + deploy tests false: only image-neutral paths
 *   suites        Full suite + API e2e run    false: draft, negctl, docs-only
 *   negctl        a negctl/* branch           true: run "Targeted tests" only
 *   negctl_tests  the test files a negctl runs (space-separated, repo-relative)
 *   hold          why a required check reports RED instead of being skipped:
 *                 "draft" | "negctl" | "stacked" | "" (see decide())
 *   draft_hold    hold == "draft" (kept for readers of the old output)
 *   reason        one line for the job log
 *
 * Usage (ci.yml): node scripts/ci-changes.mjs
 *   env EVENT, HEAD_REF, BASE_REF, DRAFT ("true"/"false"), BASE_SHA, HEAD_SHA
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

/**
 * The decision for one run. Pure: `files` is the changed path list, or null
 * when it could not be read (then everything runs).
 * `siblingTests(path)` lists test files beside a changed source file.
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
}) {
  const all = {
    gate: true,
    image: true,
    suites: true,
    negctl: false,
    negctlTests: [],
    draftHold: false,
    hold: "",
  };
  if (event !== "pull_request")
    return { ...all, reason: `${event}: every check runs` };
  if (!files)
    return { ...all, reason: "changed files unknown: every check runs" };

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
      gate: false,
      image: false,
      suites: false,
      negctl: true,
      negctlTests: [...tests].sort(),
      draftHold: false,
      hold: "negctl",
      reason: `negctl branch: only its ${tests.size} test file(s) run; every required check reports red (a negctl branch never merges)`,
    };
  }

  if (files.length > 0 && files.every(isDocsOnly))
    return {
      gate: false,
      image: false,
      suites: false,
      negctl: false,
      negctlTests: [],
      draftHold: false,
      hold: "",
      reason: `docs only (${files.length} file(s)): no check needs to run`,
    };

  const image = !files.every(isImageNeutral);
  // A base other than main/develop is a stack. It gets the Release gate (a
  // typecheck and build, so a stack is not entirely unchecked), and the suites
  // hold red: they run when the PR is retargeted to main. Docs-only returned
  // above. A stacked draft holds as "stacked".
  const stacked = !!baseRef && !LANDING_BASES.includes(baseRef);
  const hold = stacked ? "stacked" : draft ? "draft" : "";
  return {
    gate: true,
    image,
    suites: !draft && !stacked,
    negctl: false,
    negctlTests: [],
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
    reason:
      [
        stacked
          ? `base is ${baseRef}, not main: Release gate only; Full suite and API e2e report red (suites not run) until the PR targets main`
          : draft
            ? "draft: Release gate only; Full suite and API e2e report red (suites not run) until it is marked ready"
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = decide({
    event: process.env.EVENT,
    headRef: process.env.HEAD_REF,
    baseRef: process.env.BASE_REF,
    draft: process.env.DRAFT === "true",
    files: changedFiles(process.env.BASE_SHA, process.env.HEAD_SHA),
    siblingTests,
  });
  const out = [
    `gate=${d.gate}`,
    `image=${d.image}`,
    `suites=${d.suites}`,
    `negctl=${d.negctl}`,
    `negctl_tests=${d.negctlTests.join(" ")}`,
    `draft_hold=${d.draftHold}`,
    `hold=${d.hold}`,
    `reason=${d.reason}`,
  ];
  console.log(out.join("\n"));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${out.join("\n")}\n`);
}
