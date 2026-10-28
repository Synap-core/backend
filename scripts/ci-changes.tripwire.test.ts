/**
 * ci-changes.mjs decides which CI checks a change may skip. A wrong "skip" lets
 * a change merge unchecked, so this file pins the decision and guards the one
 * list that can go stale: the docs-only paths, which must be paths no test reads.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("a draft runs the Release gate, not the suites, and holds the suite checks red", () => {
    const d = pr(["packages/api/src/x.ts"], { draft: true });
    expect([d.gate, d.suites, d.draftHold]).toEqual([true, false, true]);
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
  const run = (
    name: string,
    conclusion: string | null,
    status = "completed"
  ) => ({
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
    [
      "Full suite skipped (a draft run)",
      [run("Full suite", "skipped"), run("API e2e", "success")],
    ],
    [
      "API e2e skipped",
      [run("Full suite", "success"), run("API e2e", "skipped")],
    ],
    ["neutral", [run("Full suite", "neutral"), run("API e2e", "success")]],
    ["failure", [run("Full suite", "failure"), run("API e2e", "success")]],
    [
      "still running",
      [run("Full suite", null, "in_progress"), run("API e2e", "success")],
    ],
    ["API e2e missing", [run("Full suite", "success")]],
    ["Full suite missing", [run("API e2e", "success")]],
    [
      "a shard is not the judge",
      [run("Full suite (shard 1/4)", "success"), run("API e2e", "success")],
    ],
    [
      "one of two runs red",
      [
        run("Full suite", "success"),
        run("Full suite", "failure"),
        run("API e2e", "success"),
      ],
    ],
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

describe("ci-changes: a draft's skipped suites never read as passed", () => {
  // GitHub counts a job skipped by its `if:` as a PASSED required check, so a
  // draft run that SKIPS "Full suite" and "API e2e" let backend#382 and #394
  // merge on marking ready. A draft must hold them red instead. Each row rules
  // out a looser rule: "hold = draft" fails the negctl, docs-only, push and
  // merge-queue rows; "hold = !suites" fails the negctl and docs-only rows.
  const src = ["packages/api/src/x.ts"];
  it.each([
    ["a draft", { draft: true, files: src }, true],
    ["a ready PR", { draft: false, files: src }, false],
    [
      "a draft negctl branch",
      { draft: true, files: src, headRef: "negctl/x" },
      false,
    ],
    [
      "a draft docs-only PR",
      { draft: true, files: ["docs/DEVELOPER.md"] },
      false,
    ],
    ["a draft, changed files unknown", { draft: true, files: null }, false],
    ["a push", { event: "push", draft: true, files: src }, false],
    [
      "a merge-queue run",
      { event: "merge_group", draft: true, files: src },
      false,
    ],
  ])("%s", (_label, extra, hold) => {
    const d = pr(extra.files, extra);
    expect(d.draftHold).toBe(hold);
    // A hold only ever stands in for suites that did not run.
    if (d.draftHold) expect(d.suites).toBe(false);
  });

  it("a negctl branch and a stack hold the required checks; main-based PRs do not", () => {
    // Each row rules out a looser rule: "hold = !gate" holds docs-only;
    // "hold = base != main" misses negctl on main and holds a develop PR.
    const rows: [string, object, string][] = [
      ["negctl to main", { headRef: "negctl/x", baseRef: "main" }, "negctl"],
      [
        "negctl to a stack",
        { headRef: "negctl/x", baseRef: "feat/y" },
        "negctl",
      ],
      ["a stack", { baseRef: "feat/y" }, "stacked"],
      ["a stacked draft", { baseRef: "feat/y", draft: true }, "stacked"],
      ["a draft on main", { baseRef: "main", draft: true }, "draft"],
      ["a PR to main", { baseRef: "main" }, ""],
      ["a PR to develop", { baseRef: "develop" }, ""],
      ["base unknown", {}, ""],
    ];
    for (const [label, extra, hold] of rows)
      expect(pr(["packages/api/src/x.ts"], extra).hold, label).toBe(hold);
    // A stack keeps the Release gate; a negctl runs "Targeted tests" instead.
    expect(pr(["packages/api/src/x.ts"], { baseRef: "feat/y" }).gate).toBe(
      true
    );
    expect(pr(["packages/api/src/x.ts"], { baseRef: "feat/y" }).suites).toBe(
      false
    );
    expect(pr(["packages/api/src/x.ts"], { headRef: "negctl/x" }).negctl).toBe(
      true
    );
    // Queue entries and pushes never hold.
    for (const event of ["merge_group", "push"])
      expect(
        decide({
          event,
          headRef: "negctl/x",
          baseRef: "feat/y",
          draft: true,
          files: ["packages/api/src/x.ts"],
          siblingTests: none,
        }).hold,
        event
      ).toBe("");
  });

  it("shared-package changes run the Dependent repos job; nothing else does", () => {
    const rows: [string, string[], boolean][] = [
      ["types", ["packages/types/src/x.ts"], true],
      ["api-types", ["packages/api-types/src/generated.d.ts"], true],
      ["markdown-core", ["packages/markdown-core/src/x.ts"], true],
      ["the job's own root", ["scripts/ci/dependent-root/package.json"], true],
      ["ci.yml", [".github/workflows/ci.yml"], true],
      ["api source", ["packages/api/src/x.ts"], false],
      ["a sibling named like types", ["packages/types-extra/src/x.ts"], false],
    ];
    for (const [label, files, want] of rows)
      expect(pr(files).dependents, label).toBe(want);
    expect(pr(null).dependents, "unknown files").toBe(true);
    expect(pr(["docs/DEVELOPER.md"]).dependents, "docs only").toBe(false);
    expect(
      pr(["packages/types/src/x.ts"], { headRef: "negctl/x" }).dependents
    ).toBe(false);
    expect(
      pr(["packages/types/src/x.ts"], { draft: true }).dependents,
      "a draft"
    ).toBe(true);
  });

  it("the decision reaches the job outputs (the script's own GITHUB_OUTPUT)", () => {
    const outputs = (draft: string) => {
      const file = join(mkdtempSync(join(tmpdir(), "ci-changes-")), "out");
      // HEAD...HEAD: an empty diff, so no history is needed (CI is shallow).
      execFileSync("node", ["scripts/ci-changes.mjs"], {
        cwd: REPO,
        env: {
          ...process.env,
          EVENT: "pull_request",
          HEAD_REF: "fix/x",
          DRAFT: draft,
          BASE_SHA: "HEAD",
          HEAD_SHA: "HEAD",
          GITHUB_OUTPUT: file,
        },
      });
      return readFileSync(file, "utf8").split("\n");
    };
    expect(outputs("true")).toEqual(
      expect.arrayContaining(["suites=false", "draft_hold=true"])
    );
    expect(outputs("false")).toEqual(
      expect.arrayContaining(["suites=true", "draft_hold=false"])
    );
  });

  // ci.yml read as text: the jobs block, split per job at two-space indent.
  const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
  const jobs = ci
    .slice(ci.indexOf("\njobs:\n"))
    .split(/\n(?= {2}[A-Za-z0-9_-]+:\s*\n)/)
    .slice(1)
    .map((block) => ({
      name: /^ {4}name: (.+)$/m.exec(block)?.[1] ?? "",
      if: /^ {4}if: (.+)$/m.exec(block)?.[1] ?? "",
      matrix: /^ {6}matrix:/m.test(block),
      steps: (block.split(/^ {4}steps:\n/m)[1] ?? "")
        .split(/^ {6}- /m)
        .slice(1),
      block,
    }));
  const HOLD = "needs.changes.outputs.hold != ''";
  const NEGCTL_HOLD = "needs.changes.outputs.hold == 'negctl'";

  it("the changes job exports hold and passes the base ref", () => {
    const changes = jobs.find((j) => j.name === "What changed");
    expect(changes?.block).toContain("hold: ${{ steps.decide.outputs.hold }}");
    expect(changes?.block).toContain("BASE_REF: ${{ github.base_ref }}");
  });

  it("ci.yml and reference-docs.yml run for a pull request to ANY base", () => {
    for (const file of ["ci.yml", "reference-docs.yml"]) {
      const text = readFileSync(join(REPO, ".github/workflows", file), "utf8");
      const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\njobs:\n"));
      const prBlock = /^ {2}pull_request:\n((?: {4}.*\n| *#.*\n)*)/m.exec(on);
      expect(prBlock, file).not.toBeNull();
      expect(prBlock?.[1], file).not.toMatch(/^ {4}branches:/m);
    }
  });

  // DERIVED: every job the suites decision turns off, except the matrix shards
  // (the "Full suite" judge reports for them). A new suite job joins by
  // existing and must hold too.
  const suiteJobs = jobs.filter(
    (j) => j.if.includes("needs.changes.outputs.suites == 'true'") && !j.matrix
  );

  it("the scan finds the two required suite checks", () => {
    expect(jobs.length).toBeGreaterThan(5);
    expect(suiteJobs.map((j) => j.name).sort()).toEqual([
      "API e2e",
      "Full suite",
    ]);
  });

  it("the Release gate runs on a negctl hold and its FIRST step fails", () => {
    const gate = jobs.find((j) => j.name === "Release gate");
    expect(gate?.if).toContain(NEGCTL_HOLD);
    const first = gate?.steps[0] ?? "";
    expect(first).toContain(`if: \${{ ${NEGCTL_HOLD} }}`);
    expect(first).toMatch(/\n\s+exit 1\n/);
  });

  it("Reference docs reports red for a negctl branch instead of skipping", () => {
    const text = readFileSync(
      join(REPO, ".github/workflows/reference-docs.yml"),
      "utf8"
    );
    // No job-level skip for negctl: a skipped required check reads as passed.
    expect(text).not.toMatch(/^ {4}if: .*negctl/m);
    const steps = text.split(/^ {6}- /m).slice(1);
    expect(steps[0]).toContain("startsWith(github.head_ref, 'negctl/')");
    expect(steps[0]).toMatch(/\n\s+exit 1\n/);
  });

  it("every suite job runs on a hold and its FIRST step fails", () => {
    for (const j of suiteJobs) {
      expect(j.if, j.name).toContain(HOLD);
      const first = j.steps[0] ?? "";
      expect(first, j.name).toContain(`if: \${{ ${HOLD} }}`);
      expect(first, j.name).toMatch(/\n\s+exit 1\n/);
    }
  });

  it("the Dependent repos job checks out the three repos, with the Reader App token", () => {
    const job = jobs.find((j) => j.name === "Dependent repos typecheck");
    expect(job, "job exists").toBeDefined();
    expect(job?.if).toContain("needs.changes.outputs.dependents == 'true'");
    expect(job?.block).toContain("repository: Synap-core/browser");
    expect(job?.block).toContain("repository: Synap-core/relay-app");
    // app-bases comes through monorepo-setup, whose token covers it.
    expect(job?.block).toContain("uses: ./.github/actions/monorepo-setup");
    expect(job?.block).toMatch(
      /repositories: \|\n\s+app-bases\n\s+browser\n\s+relay-app/
    );
    expect(job?.block).toContain("permission-contents: read");
    const changes = jobs.find((j) => j.name === "What changed");
    expect(changes?.block).toContain(
      "dependents: ${{ steps.decide.outputs.dependents }}"
    );
  });
});
