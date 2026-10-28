/**
 * ci-changes.mjs decides which CI checks a change may skip. A wrong "skip" lets
 * a change merge unchecked, so this file pins the decision and guards the one
 * list that can go stale: the docs-only paths, which must be paths no test reads.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import {
  decide,
  isDocsOnly,
  isImageNeutral,
  queuePrNumber,
  suitesPassed,
} from "./ci-changes.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const none = () => [];
const pr = (files: string[] | null, extra = {}) =>
  decide({
    event: "pull_request",
    headRef: "fix/x",
    draft: false,
    files,
    siblingTests: none,
    ...extra,
  });

describe("ci-changes: every check runs unless a narrow match says otherwise", () => {
  it("a push or a merge-queue run checks everything", () => {
    for (const event of ["push", "merge_group", "workflow_dispatch"]) {
      const d = decide({
        event,
        headRef: "negctl/x",
        draft: true,
        files: ["docs/x.md"],
        siblingTests: none,
      });
      expect([d.gate, d.image, d.suites, d.negctl]).toEqual([
        true,
        true,
        true,
        false,
      ]);
    }
  });

  it("a merge-queue entry whose PR's own suites passed runs the Release gate only", () => {
    const d = decide({
      event: "merge_group",
      headRef: "",
      draft: false,
      files: null,
      siblingTests: none,
      queue: { pr: 402, headSha: "550070005abc", suitesPassed: true },
    });
    expect([d.gate, d.image, d.suites, d.negctl]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(d.reason).toContain("#402");
  });

  it("a merge-queue entry without that evidence checks everything", () => {
    for (const queue of [
      null,
      { pr: 402, headSha: "x", suitesPassed: false },
    ]) {
      const d = decide({
        event: "merge_group",
        headRef: "",
        draft: false,
        files: null,
        siblingTests: none,
        queue,
      });
      expect([d.gate, d.image, d.suites]).toEqual([true, true, true]);
    }
  });

  it("only a pull request run's evidence is ever read (a push never trusts it)", () => {
    const d = decide({
      event: "push",
      headRef: "",
      draft: false,
      files: null,
      siblingTests: none,
      queue: { pr: 402, headSha: "x", suitesPassed: true },
    });
    expect(d.suites).toBe(true);
  });

  it("unknown changed files check everything", () => {
    const d = pr(null);
    expect([d.gate, d.image, d.suites]).toEqual([true, true, true]);
  });

  it("an application source change skips only the image steps", () => {
    const d = pr([
      "packages/api/src/routers/x.ts",
      "packages/api/src/routers/x.test.ts",
    ]);
    expect([d.gate, d.image, d.suites]).toEqual([true, false, true]);
  });

  it("anything image-relevant keeps the image steps", () => {
    for (const f of [
      "deploy/Dockerfile",
      "pnpm-lock.yaml",
      "packages/api/package.json",
      "packages/database/migrations/0400_x.sql",
      "packages/database/src/schema/x.ts",
      "packages/api/src/services/skills/runner/index.ts",
      "packages/api/tsup.config.ts",
      "synap",
      "scripts/smoke-test.sh",
      ".github/workflows/ci.yml",
    ]) {
      expect(isImageNeutral(f), f).toBe(false);
      expect(pr(["packages/api/src/x.ts", f]).image, f).toBe(true);
    }
  });

  it("a draft runs the Release gate, not the suites", () => {
    const d = pr(["packages/api/src/x.ts"], { draft: true });
    expect([d.gate, d.suites]).toEqual([true, false]);
  });

  it("docs only skips everything; one non-doc file brings it back", () => {
    expect(pr(["docs/DEVELOPER.md", "README.md"]).gate).toBe(false);
    expect(pr(["docs/DEVELOPER.md", "README.md"]).suites).toBe(false);
    const mixed = pr(["docs/DEVELOPER.md", "CLAUDE.md"]);
    expect([mixed.gate, mixed.suites]).toEqual([true, true]);
  });

  it("files that tests read are never docs-only", () => {
    for (const f of [
      "CLAUDE.md",
      "AGENTS.md",
      "docs/decisions/capture-vs-library.md",
      "docs/reference/openapi.json",
      "docs/architecture/official-catalog-signing.md",
      "skills/synap/SKILL.md",
      ".claude/rules/guards-and-tests.md",
    ])
      expect(isDocsOnly(f), f).toBe(false);
  });

  it("a negctl branch runs only its test files and their siblings", () => {
    const d = decide({
      event: "pull_request",
      headRef: "negctl/fix-x",
      draft: true,
      files: ["packages/api/src/a.ts", "packages/jobs/src/b.test.ts"],
      siblingTests: (f: string) =>
        f === "packages/api/src/a.ts" ? ["packages/api/src/a.test.ts"] : [],
    });
    expect([d.gate, d.image, d.suites, d.negctl]).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(d.negctlTests).toEqual([
      "packages/api/src/a.test.ts",
      "packages/jobs/src/b.test.ts",
    ]);
  });
});

describe("ci-changes: a queue entry trusts only suites that really ran", () => {
  const run = (name: string, conclusion: string | null, status = "completed") => ({
    name,
    status,
    conclusion,
  });

  it("reads the PR from the queue branch, and nothing else", () => {
    expect(
      queuePrNumber("refs/heads/gh-readonly-queue/main/pr-402-550070005abc")
    ).toBe(402);
    expect(queuePrNumber("gh-readonly-queue/main/pr-7-abc")).toBe(7);
    expect(queuePrNumber("feat/pr-402-x")).toBeNull();
    expect(queuePrNumber(undefined)).toBeNull();
  });

  it("both suites completed with success: trusted", () => {
    expect(
      suitesPassed([run("Full suite", "success"), run("API e2e", "success")])
    ).toBe(true);
  });

  // Each row rules out a looser rule: GitHub counts skipped and neutral as
  // green (a draft run reports its suites skipped), so accepting either would
  // let a PR whose suites never ran merge through a light queue run.
  it.each([
    ["Full suite skipped (a draft run)", [run("Full suite", "skipped"), run("API e2e", "success")]],
    ["API e2e skipped", [run("Full suite", "success"), run("API e2e", "skipped")]],
    ["neutral", [run("Full suite", "neutral"), run("API e2e", "success")]],
    ["failure", [run("Full suite", "failure"), run("API e2e", "success")]],
    ["still running", [run("Full suite", null, "in_progress"), run("API e2e", "success")]],
    ["API e2e missing", [run("Full suite", "success")]],
    ["Full suite missing", [run("API e2e", "success")]],
    ["a shard is not the judge", [run("Full suite (shard 1/4)", "success"), run("API e2e", "success")]],
    ["one of two runs red", [run("Full suite", "success"), run("Full suite", "failure"), run("API e2e", "success")]],
    ["no runs", []],
  ])("%s: not trusted", (_label, runs) => {
    expect(suitesPassed(runs)).toBe(false);
  });

  it("anything that is not a list is not trusted", () => {
    expect(suitesPassed(null as never)).toBe(false);
    expect(suitesPassed(undefined as never)).toBe(false);
  });
});

describe("ci-changes guard: no test reads a docs-only path", () => {
  // DERIVED, not hand-listed: every tracked file the classifier calls
  // docs-only, checked against the text of every tracked test file. A test
  // that starts reading one of them must move it out of DOCS_ONLY, or a PR
  // editing that file would merge with its suites skipped.
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: REPO,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const docsOnly = tracked.filter((f) => isDocsOnly(f));
  const tests = tracked.filter(
    (f) =>
      /\.test\.(ts|tsx|mts|mjs|js|sh)$/.test(f) &&
      f !== "scripts/ci-changes.tripwire.test.ts"
  );

  it("the scan is not vacuous", () => {
    expect(docsOnly.length).toBeGreaterThan(5);
    expect(tests.length).toBeGreaterThan(2000);
  });

  // A bare file name matches any directory's file of that name. These hits were
  // read and are NOT the repo-root file: each names `README.md` only to EXCLUDE
  // the one under skills/ from its scan. A new hit must be read the same way.
  const CHECKED_NOT_ROOT: Record<string, string> = {
    "packages/api/src/__tripwires__/relation-types-in-tool-schemas.test.ts reads README.md":
      "skips skills/**/README.md",
    "packages/api/src/__tripwires__/skill-tool-tokens-resolve.test.ts reads README.md":
      "skips skills/**/README.md",
  };

  it("no test file names a docs-only path", () => {
    const hits: string[] = [];
    for (const t of tests) {
      const text = readFileSync(join(REPO, t), "utf8");
      for (const d of docsOnly)
        if (
          d.includes("/")
            ? text.includes(d)
            : new RegExp(`['"\`/]${d.replace(".", "\\.")}['"\`]`).test(text)
        )
          hits.push(`${t} reads ${d}`);
    }
    expect(hits.filter((h) => !(h in CHECKED_NOT_ROOT))).toEqual([]);
    // Self-check: the scan still sees a literal sample of what it hunts.
    expect(hits).toContain(Object.keys(CHECKED_NOT_ROOT)[0]);
  });
});
