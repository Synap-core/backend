/**
 * The merge queue's semantic-overlap measure (scripts/ci-changes.mjs
 * "SEMANTIC OVERLAP", plan d679e92c C1(a), LOG-ONLY): before a light queue
 * entry takes its PR's own suites, it counts the test files that both the
 * PR's change and everything main gained since the PR's run can reach.
 *
 * The fixture is a small workspace shaped like #556×#558 (30 Oct): #556 put a
 * subject floor in createFocusSession; #558, green alone and queued after
 * #556 had merged, added a caller of it in give-to-agent. Together they broke
 * main through give-to-agent's test. The graph is the real one
 * (affected.mjs loadGraph over the fixture), through the production
 * `testsOf` (ci-changes.mjs overlapTestsOf).
 *
 * Each row rules a candidate rule out (guards-and-tests.md):
 *   - #556×#558: rules out "intersect only the changed files" (they share
 *     none) and "union" (the floor's own test is not the PR's);
 *   - no overlap: rules out keeping every tripwire (the fixture's tripwire,
 *     reached by neither side, would overlap every pair);
 *   - the CLI row: rules out a measure that is computed but never reaches
 *     the log line and the artifact.
 * Not covered: the GitHub reads (tested commit, its parent) run only in a
 * real queue entry; their failure is status "error" or "unknown", never a
 * changed output.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import { TEST_FILE, loadGraph } from "./affected.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { isTripwire } from "../tripwire-discovery.mjs";
import {
  overlapLine,
  overlapSummary,
  overlapTestsOf,
  semanticOverlap,
  // @ts-expect-error — plain ESM script, no declarations
} from "../ci-changes.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const API = "packages/api/src";
const FILES: Record<string, string> = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "packages/api/package.json": JSON.stringify({
    name: "@fixture/api",
    scripts: { test: "vitest run" },
  }),
  [`${API}/focus-sessions/create-session.ts`]:
    "export function createFocusSession() {}\n",
  [`${API}/focus-sessions/__tests__/create-session.subject-floor.test.ts`]:
    'import { createFocusSession } from "../create-session";\n',
  [`${API}/routers/focus-sessions.ts`]:
    'import { createFocusSession } from "../focus-sessions/create-session";\n',
  [`${API}/captures/give-to-agent.ts`]:
    'import { createFocusSession } from "../focus-sessions/create-session";\nexport const give = createFocusSession;\n',
  [`${API}/captures/__tests__/give-to-agent.test.ts`]:
    'import { give } from "../give-to-agent";\n',
  [`${API}/captures/captured-subject.ts`]:
    "export const capturedSubject = 1;\n",
  [`${API}/captures/__tests__/captured-subject.test.ts`]:
    'import { capturedSubject } from "../captured-subject";\n',
  // A tripwire neither side reaches: a PR's tier runs it whatever changed.
  [`${API}/policy.tripwire.test.ts`]: "export {};\n",
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "semantic-overlap-"));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const g = loadGraph(dir, isTripwire);
  return {
    g,
    everyTest: (g.imports.files as string[]).filter((f) => TEST_FILE.test(f)),
  };
}

const { g, everyTest } = fixture();
const testsOf = overlapTestsOf(g);

// #556: the subject floor, in createFocusSession, for every start door.
const PR_556 = [
  `${API}/focus-sessions/create-session.ts`,
  `${API}/routers/focus-sessions.ts`,
  `${API}/focus-sessions/__tests__/create-session.subject-floor.test.ts`,
];
// #558: a session started for a record is about that record.
const PR_558 = [
  `${API}/captures/give-to-agent.ts`,
  `${API}/captures/__tests__/give-to-agent.test.ts`,
  `${API}/captures/captured-subject.ts`,
  `${API}/captures/__tests__/captured-subject.test.ts`,
];

describe("semantic overlap: the tests both sides of a queue entry reach", () => {
  it("the fixture's graph is read (non-vacuity)", () => {
    expect(everyTest).toHaveLength(4);
    expect(g.tripwires).toEqual([`${API}/policy.tripwire.test.ts`]);
  });

  it("#556×#558: #558 queued after #556 merged overlaps on give-to-agent's test", () => {
    const o = semanticOverlap({
      prFiles: PR_558,
      mainFiles: PR_556,
      testsOf,
      everyTest,
    });
    expect(o.status).toBe("ok");
    expect(o.overlap).toEqual([
      `${API}/captures/__tests__/give-to-agent.test.ts`,
    ]);
    // #556 reaches its own test and give-to-agent's; #558 its two tests.
    expect([o.prTests, o.mainTests]).toEqual([2, 2]);
    expect(overlapLine(o)).toBe(
      `semantic overlap: 1 test file(s) would re-run: ${API}/captures/__tests__/give-to-agent.test.ts (PR side 2, main side 2); reuse unchanged (log-only)`
    );
    expect(overlapSummary(o)).toContain(
      `- \`${API}/captures/__tests__/give-to-agent.test.ts\``
    );
  });

  it("no overlap: a PR that reaches none of main's tests overlaps on nothing, tripwires included", () => {
    const o = semanticOverlap({
      prFiles: [
        `${API}/captures/captured-subject.ts`,
        `${API}/captures/__tests__/captured-subject.test.ts`,
      ],
      mainFiles: PR_556,
      testsOf,
      everyTest,
    });
    expect(o.status).toBe("ok");
    expect(o.overlap).toEqual([]);
    expect([o.prTests, o.mainTests]).toEqual([1, 2]);
    expect(overlapLine(o)).toMatch(
      /^semantic overlap: 0 test file\(s\) would re-run \(/
    );
  });

  it("a full-suite side (root config) reaches every test: the overlap is the other side's", () => {
    const o = semanticOverlap({
      prFiles: PR_558,
      mainFiles: ["pnpm-lock.yaml"],
      testsOf,
      everyTest,
    });
    expect(o.mainFull).toBe(true);
    expect(o.overlap).toEqual([
      `${API}/captures/__tests__/captured-subject.test.ts`,
      `${API}/captures/__tests__/give-to-agent.test.ts`,
    ]);
    expect(
      o.why.some((w: string) => w.startsWith("main side: full suite"))
    ).toBe(true);
  });

  it("main unchanged since the PR's run, or an unreadable side: nothing overlaps, and it says why", () => {
    expect(
      semanticOverlap({ prFiles: PR_558, mainFiles: [], testsOf, everyTest })
    ).toMatchObject({ status: "ok", overlap: [], mainTests: 0 });
    expect(
      semanticOverlap({ prFiles: PR_558, mainFiles: null, testsOf, everyTest })
    ).toMatchObject({ status: "unknown", overlap: [] });
    expect(
      semanticOverlap({
        prFiles: PR_558,
        mainFiles: PR_556,
        testsOf: () => null,
        everyTest,
      })
    ).toMatchObject({
      status: "unknown",
      why: ["dependency graph unreadable"],
    });
  });

  it("a queue entry logs the measure and writes the artifact, with the decision's outputs unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "semantic-overlap-cli-"));
    // No REPO or token: no queue evidence, so the entry runs its suites and
    // the measure is "unknown". HEAD...HEAD: no history needed.
    const env: Record<string, string | undefined> = {
      ...process.env,
      EVENT: "merge_group",
      QUEUE_HEAD_REF: "refs/heads/gh-readonly-queue/main/pr-558-abc",
      QUEUE_BASE_SHA: "HEAD",
      QUEUE_HEAD_SHA: "HEAD",
      GITHUB_OUTPUT: join(dir, "out"),
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      SELECTION_OUT: join(dir, "selection.json"),
      OVERLAP_OUT: join(dir, "overlap.json"),
    };
    delete env.REPO;
    delete env.GITHUB_TOKEN;
    const log = execFileSync("node", ["scripts/ci-changes.mjs"], {
      cwd: REPO,
      env,
      encoding: "utf8",
    });
    expect(log).toContain(
      "semantic overlap: unknown (no queue evidence); reuse unchanged (log-only)"
    );
    const out = readFileSync(join(dir, "out"), "utf8").split("\n");
    expect(out).toEqual(expect.arrayContaining(["reuse=false", "gate=true"]));
    const json = JSON.parse(readFileSync(join(dir, "overlap.json"), "utf8"));
    expect(json).toMatchObject({
      status: "unknown",
      overlapCount: 0,
      decision: "suites",
      pr: null,
    });
    expect(readFileSync(join(dir, "summary"), "utf8")).toContain(
      "### Merge queue: semantic overlap (log-only"
    );
    // The CLI reads this checkout's whole graph (~5-10 s).
  }, 60_000);
});
