/**
 * merge-bot.mjs enqueues backend PRs into the merge queue and runs main's
 * victims again. A wrong "enqueue" puts a red, draft, unowned or
 * self-certifying PR in front of main; a wrong "run again" spends ~6 of the
 * org's 20 jobs per PR, forever if the once-only guard breaks. So this pins
 * each eligibility condition both ways, the CI-infrastructure refusal, the
 * red-main default, the jump rule, the red window, the once-only guard, the
 * fail-safe without the app's secrets, the secrets' environment, and the
 * writes the bot must never make, through the real script driving a fake
 * `gh` (the argument shapes are the wire).
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 *
 * NOT covered (needs the live API): that GitHub accepts the mutations from
 * the app's token, that `jump` is allowed for an app, that an app's
 * `ready_for_review` starts CI without approval, the exact text of GitHub's
 * "already queued" error (ALREADY_QUEUED is a guess at it).
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALREADY_QUEUED,
  GITHUB_ACTIONS_APP_ID,
  INFRA_PATHS,
  INFRA_REASON,
  MAX_TOGGLES_PER_SWEEP,
  RERUN_CHECK_NAME,
  dependsState,
  enqueueDecision,
  ghTransport,
  infraFilesOf,
  isInfraPath,
  isMainRedFix,
  jumpReason,
  liveRequiredChecks,
  mainRedWindow,
  mainState,
  prGates,
  requiredChecksState,
  runBot,
  victimDecision,
  // @ts-expect-error — plain ESM script, no declarations
} from "./merge-bot.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { REQUIRED_CHECKS } from "./release-gate-wait.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SID = "4a33beb9-716a-4b54-a0ac-51255a973db5";
const HEAD = "a".repeat(40);

type Pr = Record<string, any>;
const pr = (over: Pr = {}): Pr => ({
  id: "PR_kwDOabc",
  number: 500,
  title: "feat: a thing",
  body: `What.\n\nPod session: ${SID}\n`,
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat/a-thing",
  headRefOid: HEAD,
  isCrossRepository: false,
  mergeable: "MERGEABLE",
  isInMergeQueue: false,
  author: { login: "Antoinesrvt" },
  labels: { nodes: [] },
  ...over,
});
const labelled = (...names: string[]) => ({
  labels: { nodes: names.map((name) => ({ name })) },
});
const checkRun = (
  name: string,
  conclusion: string | null = "success",
  over: Pr = {}
) => ({
  id: 1,
  name,
  head_sha: HEAD,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  started_at: "2026-10-29T10:00:00Z",
  app: { id: GITHUB_ACTIONS_APP_ID },
  ...over,
});
const greenRuns = () => REQUIRED_CHECKS.map((n: string) => checkRun(n));
const greenChecks = () => requiredChecksState(greenRuns(), HEAD);
const LANDED = { state: "landed", behind: [] };
const SOURCE_FILES = [{ filename: "packages/api/src/x.ts" }];
const decide = (p: Pr, over: Pr = {}) =>
  enqueueDecision({
    pr: p,
    checks: greenChecks(),
    depends: LANDED,
    files: SOURCE_FILES,
    ...over,
  });

describe("merge-bot: the Pod session line (pod-observation.mjs's parser)", () => {
  it.each([
    ["a plain line", `Pod session: ${SID}`],
    ["text after the id", `Pod session: ${SID} (child of wave session x).`],
    ["a code-spanned id", "Pod session: `" + SID + "`"],
    ["indented, any case", `  pod Session: ${SID.toUpperCase()}`],
  ])("enqueued: %s", (_n, line) => {
    expect(decide(pr({ body: `x\n${line}\ny` })).enqueue).toBe(true);
  });
  it.each([
    ["no line", "What and why."],
    ["mid-line mention", `Devbox at 2c19950c7 (pod session ${SID}):`],
    ["a short id", "Pod session: 9307efb5"],
  ])("not enqueued: %s", (_n, body) => {
    const d = decide(pr({ body }));
    expect(d.enqueue).toBe(false);
    expect(d.reasons.join("; ")).toContain("Pod session");
  });
});

describe("merge-bot: the jump rule", () => {
  const RED = { mainRed: true };
  it.each([
    [
      "a fix/main-red-* branch",
      { headRefName: "fix/main-red-tokens-mirror" },
      "main-red fix",
    ],
    [
      "the culprit finder's revert branch",
      { headRefName: "fix/main-red-revert-409270a3" },
      "main-red fix",
    ],
    [
      "a fix: main red title",
      { title: "fix: main red, the ochre-tokens mirror" },
      "main-red fix",
    ],
    [
      "a fix(scope): main red title",
      { title: "fix(ci): main red @409270a3" },
      "main-red fix",
    ],
    ["any case", { title: "Fix: Main red after #476" }, "main-red fix"],
    [
      "GitHub's revert title",
      { title: 'Revert "feat: purpose-first keys"' },
      "revert",
    ],
    ["the security label", labelled("security"), "security fix"],
    [
      "the Security label, any case",
      labelled("ci", "Security"),
      "security fix",
    ],
  ])("jumps while main is red: %s", (_n, over: Pr, why: string) => {
    expect(jumpReason(pr(over), RED)).toBe(why);
    expect(decide(pr(over), { mainRed: "red" })).toMatchObject({
      enqueue: true,
      jump: true,
      jumpReason: why,
    });
  });
  it.each([
    ["a fix/main-red-* branch", { headRefName: "fix/main-red-x" }],
    ["a fix: main red title", { title: "fix: main red" }],
    ["GitHub's revert title", { title: 'Revert "feat: x"' }],
  ])("does NOT jump while main is green: %s", (_n, over: Pr) => {
    expect(jumpReason(pr(over), { mainRed: false })).toBeNull();
    expect(decide(pr(over))).toMatchObject({ enqueue: true, jump: false });
  });
  it("the security label jumps while main is green too", () => {
    expect(decide(pr(labelled("security")))).toMatchObject({
      jump: true,
      jumpReason: "security fix",
    });
  });
  it.each([
    ["an ordinary PR", {}],
    [
      "a fix/security-* branch (anyone can name a branch)",
      { headRefName: "fix/security-token-leak" },
    ],
    [
      "a fix(security) title (anyone can write a title)",
      { title: "fix(security): scope the hub key" },
    ],
    [
      "a label that only contains the word",
      labelled("security-review", "insecure"),
    ],
    ["fix/main-redo-cache", { headRefName: "fix/main-redo-cache" }],
    ["feat/main-red-banner", { headRefName: "feat/main-red-banner" }],
    ["feat: main red banner", { title: "feat: main red banner" }],
    ["fix: mainly red tests", { title: "fix: mainly red tests" }],
    ["chore: fix main red later", { title: "chore: fix main red later" }],
    ["a revert: title (no quote)", { title: "revert: the old banner" }],
    ['a "Reverted" title', { title: 'Reverted "x" by hand' }],
    ["Revert in the middle", { title: 'fix: Revert "x" partly' }],
  ])("never jumps, even while main is red: %s", (_n, over: Pr) => {
    expect(jumpReason(pr(over), RED)).toBeNull();
  });
  it("isMainRedFix reads the branch and the title", () => {
    expect(isMainRedFix(pr({ headRefName: "fix/main-red-y" }))).toBe(true);
    expect(isMainRedFix(pr())).toBe(false);
  });
});

describe("merge-bot: while main is red, only jumpers are enqueued (founder default)", () => {
  it("an ordinary green PR waits while main is red", () => {
    const d = decide(pr(), { mainRed: "red" });
    expect(d.enqueue).toBe(false);
    expect(d.reasons.join("; ")).toMatch(/main is red/);
  });
  it("main's state unknown: only a security fix", () => {
    expect(decide(pr(), { mainRed: "unknown" }).enqueue).toBe(false);
    expect(
      decide(pr({ headRefName: "fix/main-red-x" }), { mainRed: "unknown" })
        .enqueue
    ).toBe(false);
    expect(
      decide(pr(labelled("security")), { mainRed: "unknown" }).enqueue
    ).toBe(true);
  });
  it("the founder's override enqueues every eligible PR", () => {
    expect(decide(pr(), { mainRed: "red", whileRed: true }).enqueue).toBe(true);
  });
  it("main's state from its finished push runs", () => {
    expect(
      mainState([
        mainRun(2, "failure", "2026-10-29T09:00:00Z"),
        mainRun(1, "success", "2026-10-29T08:00:00Z"),
      ])
    ).toBe("red");
    expect(
      mainState([
        mainRun(2, "cancelled", "2026-10-29T09:00:00Z"),
        mainRun(1, "success", "2026-10-29T08:00:00Z"),
      ])
    ).toBe("green");
    expect(mainState([])).toBe("unknown");
  });
});

describe("merge-bot: a PR touching CI or test infrastructure needs the founder", () => {
  it.each([
    [".github/workflows/ci.yml"],
    [".github/actions/monorepo-setup/action.yml"],
    ["scripts/ci/merge-bot.mjs"],
    ["scripts/ci-changes.mjs"],
    ["scripts/test-ratchet.mjs"],
    ["scripts/test-ratchet-baseline.txt"],
    ["scripts/layout/hold.mjs"],
    ["scripts/tripwires.mjs"],
    ["scripts/tripwire-discovery.mjs"],
    ["scripts/preflight.mjs"],
    ["scripts/check-publish-freshness.mjs"],
    ["packages/api/vitest.config.ts"],
    ["packages/database/vitest.unit.config.ts"],
    ["turbo.json"],
    [".husky/pre-push"],
    ["ci/scripts/check.mjs"],
  ])("refused: %s", (path) => {
    expect(isInfraPath(path)).toBe(true);
    const d = decide(pr(), { files: [{ filename: path }] });
    expect(d.enqueue).toBe(false);
    expect(d.reasons.join("; ")).toContain(INFRA_REASON);
  });
  it.each([
    ["packages/api/src/routers/x.ts"],
    ["packages/api/src/x.test.ts"],
    // A product file that is not code (no docs-only path here: a docs-only
    // PR runs no tests, so ci-changes' guard forbids a test naming one).
    ["packages/database/migrations/0300_example.sql"],
    ["scripts/gen-types.mjs"],
    ["packages/vitest-helpers/src/a.ts"],
  ])("not infrastructure: %s", (path) => {
    expect(isInfraPath(path)).toBe(false);
    expect(decide(pr(), { files: [{ filename: path }] }).enqueue).toBe(true);
  });
  it("a rename OUT of the infrastructure counts (its old name is read)", () => {
    expect(
      infraFilesOf([
        {
          filename: "packages/api/src/old-ci.yml",
          previous_filename: ".github/workflows/ci.yml",
        },
      ])
    ).toEqual([".github/workflows/ci.yml"]);
  });
  it("files that could not be read: refused, never taken for clean", () => {
    const d = decide(pr(), { files: null });
    expect(d.enqueue).toBe(false);
    expect(d.reasons.join("; ")).toMatch(/files could not be read/);
  });
  it("files not read: refused", () => {
    expect(decide(pr(), { files: undefined }).enqueue).toBe(false);
  });
  it("every script the workflows run is classified: infrastructure, or acknowledged product code", () => {
    // Derived, never hand-listed: every path under scripts/ or ci/ that a
    // workflow or composite action names. A new one fails here until it is
    // classified. PRODUCT = scripts CI runs whose verdict is not their own
    // output (they build or test the product; a PR changing them still faces
    // the same tests).
    const PRODUCT = new Set([
      "scripts/docs/gen-reference.ts",
      "scripts/gen-types.mjs",
      "scripts/migrate.js",
      "scripts/pod-observation.mjs",
      "scripts/release-min-from.mjs",
      "scripts/schema-hash.mjs",
      "scripts/skill-runner-sandbox-smoke.mjs",
      "scripts/verify-publishable.mjs",
    ]);
    const roots = [
      join(REPO, ".github/workflows"),
      join(REPO, ".github/actions/monorepo-setup"),
    ];
    const text = roots
      .flatMap((d) => readdirSync(d).map((f) => join(d, f)))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const named = [
      ...new Set(
        [
          ...text.matchAll(
            /(?:\.\/)?((?:scripts|ci)\/[A-Za-z0-9_./-]+\.(?:mjs|js|sh|ts|json|txt))/g
          ),
        ].map((m) => m[1])
      ),
    ];
    expect(named.length).toBeGreaterThan(15); // the scan sees the workflows
    expect(named).toContain("scripts/ci-changes.mjs");
    const unclassified = named.filter(
      (p) => !isInfraPath(p) && !PRODUCT.has(p)
    );
    expect(unclassified).toEqual([]);
    for (const p of PRODUCT) expect(isInfraPath(p)).toBe(false);
    expect(INFRA_PATHS.length).toBeGreaterThan(5);
  });
});

describe("merge-bot: the required checks", () => {
  it("are the ruleset's four, posted by the app the ruleset names", () => {
    const sh = readFileSync(
      join(REPO, "scripts/apply-main-protection.sh"),
      "utf8"
    );
    const required = [
      ...(/^REQUIRED_CHECKS=\((.+)\)$/m.exec(sh)?.[1] ?? "").matchAll(
        /"([^"]+)"/g
      ),
    ].map((m) => m[1]);
    expect(required.length).toBe(4);
    expect([...REQUIRED_CHECKS].sort()).toEqual([...required].sort());
    expect(Number(/^GITHUB_ACTIONS_APP_ID=(\d+)/m.exec(sh)?.[1])).toBe(
      GITHUB_ACTIONS_APP_ID
    );
  });
  it("all four success on the head: ok", () => {
    expect(greenChecks().ok).toBe(true);
  });
  it.each(REQUIRED_CHECKS.map((n: string) => [n]))(
    "%s red, running or absent: not ok",
    (name: string) => {
      for (const runs of [
        greenRuns().map((c: Pr) =>
          c.name === name ? checkRun(name, "failure") : c
        ),
        greenRuns().map((c: Pr) =>
          c.name === name ? checkRun(name, null) : c
        ),
        greenRuns().map((c: Pr) =>
          c.name === name ? checkRun(name, "cancelled") : c
        ),
        greenRuns().filter((c: Pr) => c.name !== name),
      ])
        expect(requiredChecksState(runs, HEAD).ok).toBe(false);
    }
  );
  it("a success posted by another app does not count", () => {
    const runs = [
      ...greenRuns().filter((c: Pr) => c.name !== "Full suite"),
      checkRun("Full suite", "success", { app: { id: 999 } }),
      checkRun("Full suite", "failure"),
    ];
    expect(requiredChecksState(runs, HEAD)).toMatchObject({
      ok: false,
      notGreen: ["Full suite: failure"],
    });
  });
  it("the latest run of a name wins", () => {
    const runs = [
      ...greenRuns().filter((c: Pr) => c.name !== "API e2e"),
      checkRun("API e2e", "success", {
        id: 5,
        started_at: "2026-10-29T09:00:00Z",
      }),
      checkRun("API e2e", "failure", {
        id: 6,
        started_at: "2026-10-29T10:30:00Z",
      }),
    ];
    expect(requiredChecksState(runs, HEAD).ok).toBe(false);
  });
  it("checks of another commit do not count", () => {
    expect(
      requiredChecksState(
        greenRuns().map((c: Pr) => ({ ...c, head_sha: "b".repeat(40) })),
        HEAD
      ).ok
    ).toBe(false);
  });
});

describe("merge-bot: enqueue eligibility, each condition both ways", () => {
  it("an eligible PR is enqueued", () => {
    expect(decide(pr())).toMatchObject({
      enqueue: true,
      jump: false,
      jumpReason: null,
      rides: [],
      reasons: [],
    });
  });
  it("mergeable UNKNOWN is not CONFLICTING: enqueued (the mutation refuses a real conflict)", () => {
    expect(decide(pr({ mergeable: "UNKNOWN" })).enqueue).toBe(true);
  });
  const red = (name: string) =>
    requiredChecksState(
      greenRuns().map((c: Pr) =>
        c.name === name ? checkRun(name, "failure") : c
      ),
      HEAD
    );
  it.each([
    ["base not main", { pr: pr({ baseRefName: "develop" }) }, "base"],
    ["closed", { pr: pr({ state: "CLOSED" }) }, "state"],
    ["a draft", { pr: pr({ isDraft: true }) }, "draft"],
    [
      "a negctl branch",
      { pr: pr({ headRefName: "negctl/feat/a-thing" }) },
      "negctl",
    ],
    [
      "dependabot (author)",
      { pr: pr({ author: { login: "dependabot" } }) },
      "dependabot",
    ],
    [
      "dependabot (branch)",
      { pr: pr({ headRefName: "dependabot/github_actions/x-1.2" }) },
      "dependabot",
    ],
    ["from a fork", { pr: pr({ isCrossRepository: true }) }, "fork"],
    [
      "no Pod session line",
      { pr: pr({ body: "What and why." }) },
      "Pod session",
    ],
    [
      "a Depends-On still open",
      { pr: pr(), depends: { state: "waiting", behind: [] } },
      "Depends-On",
    ],
    [
      "a Depends-On that cannot land",
      { pr: pr(), depends: { state: "blocked", behind: [] } },
      "Depends-On",
    ],
    ["Depends-On not read", { pr: pr(), depends: undefined }, "Depends-On"],
    [
      "Release gate red",
      { pr: pr(), checks: red("Release gate") },
      "Release gate",
    ],
    ["Full suite red", { pr: pr(), checks: red("Full suite") }, "Full suite"],
    ["checks not read", { pr: pr(), checks: undefined }, "required checks"],
    ["conflicting", { pr: pr({ mergeable: "CONFLICTING" }) }, "conflicting"],
    ["already queued", { pr: pr({ isInMergeQueue: true }) }, "queued"],
  ])("not enqueued: %s", (_n, input: Pr, reason: string) => {
    const d = enqueueDecision({
      checks: greenChecks(),
      depends: LANDED,
      files: SOURCE_FILES,
      ...input,
    });
    expect(d.enqueue).toBe(false);
    expect(d.reasons.join("; ")).toContain(reason);
  });
  it("the shared gates are one function (enqueue and victims)", () => {
    expect(prGates(pr())).toEqual([]);
    expect(prGates(pr({ isDraft: true, isCrossRepository: true }))).toEqual([
      "draft",
      "from a fork",
    ]);
  });
});

// Main's CI push runs (the function sorts).
const mainRun = (
  id: number,
  conclusion: string,
  created: string,
  over: Pr = {}
) => ({
  id,
  event: "push",
  head_branch: "main",
  status: "completed",
  conclusion,
  created_at: created,
  updated_at: created.replace(
    /T(\d\d)/,
    (_m, h) => `T${String(Number(h) + 1).padStart(2, "0")}`
  ),
  ...over,
});
const NOW = Date.parse("2026-10-29T12:00:00Z");

describe("merge-bot: main's red window", () => {
  it("green after one red: from the red push to the green run's end", () => {
    const w = mainRedWindow(
      [
        mainRun(3, "success", "2026-10-29T09:54:00Z"),
        mainRun(2, "failure", "2026-10-29T01:00:00Z"),
        mainRun(1, "success", "2026-10-28T20:00:00Z"),
      ],
      { now: NOW }
    );
    expect(w).toMatchObject({
      start: "2026-10-29T01:00:00Z",
      end: "2026-10-29T10:54:00Z",
      key: "main-green-3",
    });
  });
  it("a streak of reds: the window starts at the FIRST red; cancelled runs say nothing", () => {
    const w = mainRedWindow(
      [
        mainRun(5, "success", "2026-10-29T09:54:00Z"),
        mainRun(4, "failure", "2026-10-29T03:00:00Z"),
        mainRun(3, "cancelled", "2026-10-29T02:00:00Z"),
        mainRun(2, "failure", "2026-10-29T01:00:00Z"),
        mainRun(1, "success", "2026-10-28T20:00:00Z"),
      ],
      { now: NOW }
    );
    expect(w).toMatchObject({
      start: "2026-10-29T01:00:00Z",
      firstRed: { id: 2 },
      lastRed: { id: 4 },
    });
  });
  it("a LATER green does not erase it: the latest transition of the last 24 h still answers", () => {
    const w = mainRedWindow(
      [
        mainRun(4, "success", "2026-10-29T11:00:00Z"),
        mainRun(3, "success", "2026-10-29T09:54:00Z"),
        mainRun(2, "failure", "2026-10-29T01:00:00Z"),
      ],
      { now: NOW }
    );
    expect(w).toMatchObject({
      key: "main-green-3",
      start: "2026-10-29T01:00:00Z",
    });
  });
  it.each([
    [
      "main red again",
      [
        mainRun(3, "failure", "2026-10-29T10:00:00Z"),
        mainRun(2, "success", "2026-10-29T09:00:00Z"),
        mainRun(1, "failure", "2026-10-29T08:00:00Z"),
      ],
    ],
    [
      "green after green, no red in the list",
      [
        mainRun(2, "success", "2026-10-29T09:00:00Z"),
        mainRun(1, "success", "2026-10-29T08:00:00Z"),
      ],
    ],
    [
      "only a running run after the red",
      [
        mainRun(2, "success", "2026-10-29T09:00:00Z", {
          status: "in_progress",
          conclusion: null,
        }),
        mainRun(1, "failure", "2026-10-29T08:00:00Z"),
      ],
    ],
    [
      "a pull_request run is not main",
      [
        mainRun(2, "success", "2026-10-29T09:00:00Z"),
        mainRun(1, "failure", "2026-10-29T08:00:00Z", {
          event: "pull_request",
        }),
      ],
    ],
    [
      "the transition is over 24 h old",
      [
        mainRun(3, "success", "2026-10-29T09:00:00Z"),
        mainRun(2, "success", "2026-10-27T09:00:00Z"),
        mainRun(1, "failure", "2026-10-27T08:00:00Z"),
      ],
    ],
    ["no runs", []],
  ])("no window: %s", (_n, runs) => {
    expect(mainRedWindow(runs, { now: NOW })).toBeNull();
  });
});

const WINDOW = mainRedWindow(
  [
    mainRun(3, "success", "2026-10-29T09:54:00Z"),
    mainRun(2, "failure", "2026-10-29T01:00:00Z"),
  ],
  { now: NOW }
);
const prRun = (over: Pr = {}) => ({
  id: 77,
  event: "pull_request",
  head_sha: HEAD,
  status: "completed",
  conclusion: "failure",
  created_at: "2026-10-29T04:00:00Z",
  ...over,
});
const MAIN_TIP = "c".repeat(40);
const victim = (over: Pr = {}) =>
  victimDecision({
    pr: pr(),
    window: WINDOW,
    latestRun: prRun(),
    markers: [],
    merge: { mergeable: true, baseSha: MAIN_TIP, mainSha: MAIN_TIP },
    ...over,
  });

describe("merge-bot: main's victims, run again once", () => {
  it("a PR whose latest run failed while main was red: run again", () => {
    expect(victim()).toEqual({ rerun: true, reasons: [] });
  });
  it("a marker for ANOTHER main red does not hold it", () => {
    expect(
      victim({
        markers: [{ name: RERUN_CHECK_NAME, external_id: "main-green-1" }],
      }).rerun
    ).toBe(true);
  });
  it("a PR touching CI infrastructure is still a victim (toggling certifies nothing)", () => {
    expect(victim({ pr: pr({ headRefName: "ci/x" }) }).rerun).toBe(true);
  });
  it.each([
    ["main not just green", { window: null }, "not just back to green"],
    [
      "IN the merge queue (a draft toggle would dequeue it)",
      { pr: pr({ isInMergeQueue: true }) },
      "in the merge queue",
    ],
    ["a draft", { pr: pr({ isDraft: true }) }, "draft"],
    [
      "a negctl branch (red on purpose)",
      { pr: pr({ headRefName: "negctl/x" }) },
      "negctl",
    ],
    ["base not main", { pr: pr({ baseRefName: "release/1" }) }, "base"],
    ["from a fork", { pr: pr({ isCrossRepository: true }) }, "fork"],
    ["no run", { latestRun: null }, "no CI run"],
    [
      "its run passed",
      { latestRun: prRun({ conclusion: "success" }) },
      "ended success",
    ],
    [
      "its run was cancelled",
      { latestRun: prRun({ conclusion: "cancelled" }) },
      "ended cancelled",
    ],
    [
      "its run is still going",
      { latestRun: prRun({ status: "in_progress", conclusion: null }) },
      "in_progress",
    ],
    [
      "its run predates the red push",
      { latestRun: prRun({ created_at: "2026-10-29T00:59:00Z" }) },
      "not created while main was red",
    ],
    [
      "its run came after main was green",
      { latestRun: prRun({ created_at: "2026-10-29T11:00:00Z" }) },
      "not created while main was red",
    ],
    [
      "its run is of an older commit",
      { latestRun: prRun({ head_sha: "b".repeat(40) }) },
      "another commit",
    ],
    [
      "ALREADY run again for this main red (once only)",
      { markers: [{ name: RERUN_CHECK_NAME, external_id: "main-green-3" }] },
      "already run again",
    ],
    [
      "the test merge is not built",
      { merge: { mergeable: null, baseSha: null, mainSha: MAIN_TIP } },
      "not ready",
    ],
    [
      "the test merge is on an old main",
      {
        merge: { mergeable: true, baseSha: "d".repeat(40), mainSha: MAIN_TIP },
      },
      "main's tip",
    ],
    ["markers not read", { markers: undefined }, "not read"],
  ])("not run again: %s", (_n, over: Pr, reason: string) => {
    const d = victim(over);
    expect(d.rerun).toBe(false);
    expect(d.reasons.join("; ")).toContain(reason);
  });
});

// ── dependents ride with their dependency ───────────────────────────────────

const BACKEND = "Synap-core/backend";
const sha = (ch: string) => ch.repeat(40);
const waitingOn = (n: number, repo = BACKEND, kind = "pr") => ({
  dep: { kind, repo, number: n, label: `backend#${n}` },
  status: "waiting",
  testRef: null,
  detail: "open, into main",
});
const landedOn = (n: number) => ({ ...waitingOn(n), status: "landed" });

describe("merge-bot: a dependent rides with its queued dependency", () => {
  const queued = new Map([[20, sha("2")]]);
  it("an open backend dependency IN the queue: rides behind it", () => {
    expect(dependsState([waitingOn(20)], { repo: BACKEND, queued })).toEqual({
      state: "rides",
      behind: [20],
    });
    expect(
      dependsState([waitingOn(20), landedOn(9)], { repo: BACKEND, queued })
        .state
    ).toBe("rides");
  });
  it.each([
    ["the dependency is NOT queued", [waitingOn(21)]],
    [
      "a dependency in ANOTHER repo never rides",
      [waitingOn(20, "Synap-core/app-bases")],
    ],
    ["a commit dependency never rides", [waitingOn(20, BACKEND, "ref")]],
    ["one queued, one not", [waitingOn(20), waitingOn(21)]],
  ])("waits: %s", (_n, results) => {
    expect(dependsState(results, { repo: BACKEND, queued }).state).toBe(
      "waiting"
    );
  });
  it("a blocked line is still blocked", () => {
    expect(
      dependsState([waitingOn(20), { ...waitingOn(9), status: "blocked" }], {
        repo: BACKEND,
        queued,
      }).state
    ).toBe("blocked");
  });
  it("no dependency, or all landed: landed", () => {
    expect(dependsState([], { repo: BACKEND, queued })).toEqual({
      state: "landed",
      behind: [],
    });
    expect(dependsState([landedOn(9)], { repo: BACKEND, queued }).state).toBe(
      "landed"
    );
  });
  const rides = { state: "rides", behind: [20] };
  it("riding ON: enqueued, and never jumps ahead of its dependency", () => {
    expect(decide(pr(), { depends: rides, riding: true })).toMatchObject({
      enqueue: true,
      jump: false,
      rides: [20],
    });
    expect(
      decide(pr(labelled("security")), { depends: rides, riding: true })
    ).toMatchObject({ enqueue: true, jump: false, jumpReason: null });
  });
  it("riding OFF: not enqueued, and the log says why", () => {
    const d = decide(pr(), { depends: rides, riding: false });
    expect(d.enqueue).toBe(false);
    expect(d.reasons.join("; ")).toMatch(/riding is off/);
  });
  it("a dependency NOT queued is not enqueued, riding or not", () => {
    for (const riding of [true, false])
      expect(
        decide(pr(), { depends: { state: "waiting", behind: [] }, riding })
          .enqueue
      ).toBe(false);
  });
  it("reads main's required checks from its live rules; a failed read is null", () => {
    const gh = (rules: unknown, fail = false) => ({
      rest: () => {
        if (fail) throw new Error("HTTP 404");
        return rules;
      },
    });
    const rules = [
      { type: "pull_request", parameters: {} },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "Release gate" },
            { context: "Dependencies merged" },
          ],
        },
      },
    ];
    expect(liveRequiredChecks(gh(rules), BACKEND, "t")).toEqual([
      "Release gate",
      "Dependencies merged",
    ]);
    expect(liveRequiredChecks(gh(null, true), BACKEND, "t")).toBeNull();
    expect(
      liveRequiredChecks(gh({ message: "Not Found" }), BACKEND, "t")
    ).toBeNull();
  });
});

// ── the script end to end, through a fake `gh` ──────────────────────────────

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.env.FAKE_GH_DATA, "utf8"));
const args = process.argv.slice(2);
let input = "";
if (args.includes("--input")) input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, token: process.env.GH_TOKEN, input }) + "\\n");
const say = (x) => { process.stdout.write(JSON.stringify(x)); process.exit(0); };
const die = (m) => { process.stderr.write(m); process.exit(1); };
if (args[1] === "graphql") {
  const q = (args.find((a) => a.startsWith("query=")) || "").slice(6);
  const jump = args.includes("jump=true");
  if (q.includes("pullRequests(")) say({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: data.prs } } } });
  if (q.includes("enqueuePullRequest")) {
    if (data.alreadyQueued) die("GraphQL: Pull request is already in the merge queue (enqueuePullRequest)");
    if (jump && data.refuseJump) die("GraphQL: jump not allowed");
    say({ data: { enqueuePullRequest: { mergeQueueEntry: { position: 1, state: "QUEUED" } } } });
  }
  if (q.includes("convertPullRequestToDraft")) say({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } });
  if (q.includes("markPullRequestReadyForReview")) say({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
  die("fake gh: unknown query");
}
const method = args[2], path = args[3];
if (method === "POST" && path.endsWith("/check-runs")) say({ id: 1 });
let m;
if ((m = /commits\\/([0-9a-f]+)\\/check-runs\\?check_name=/.exec(path))) say({ check_runs: (data.markers || {})[m[1]] || [] });
if ((m = /commits\\/([0-9a-f]+)\\/check-runs/.exec(path))) say({ check_runs: (data.checks || {})[m[1]] || [] });
if (path.includes("runs?branch=main&event=push")) { if (data.mainRuns === null) die("gh: HTTP 502"); say({ workflow_runs: data.mainRuns || [] }); }
if ((m = /runs\\?event=pull_request&head_sha=([0-9a-f]+)/.exec(path))) say({ workflow_runs: (data.prRuns || {})[m[1]] || [] });
if (path.endsWith("git/ref/heads/main")) say({ object: { sha: data.mainSha } });
if (path.includes("rules/branches/main")) { if (data.rules === undefined) die("gh: Not Found (HTTP 404)"); say(data.rules); }
if ((m = /pulls\\/(\\d+)\\/files\\?per_page=100&page=(\\d+)/.exec(path))) {
  if ((data.unreadableFiles || []).includes(Number(m[1]))) die("gh: HTTP 502");
  say(m[2] === "1" ? ((data.files || {})[m[1]] || [{ filename: "packages/api/src/x.ts" }]) : []);
}
if ((m = /pulls\\/(\\d+)$/.exec(path))) say((data.pulls || {})[m[1]] || {});
if ((m = /commits\\/([0-9a-f]+)$/.exec(path))) say({ parents: [{ sha: (data.mergeBase || {})[m[1]] }] });
die("fake gh: unknown path " + path);
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const required = (...ctx: string[]) => [
  {
    type: "required_status_checks",
    parameters: { required_status_checks: ctx.map((context) => ({ context })) },
  },
];
const GREEN_MAIN = [mainRun(1, "success", "2026-10-29T08:00:00Z")];
const RED_MAIN = [
  mainRun(2, "failure", "2026-10-29T09:00:00Z"),
  mainRun(1, "success", "2026-10-29T08:00:00Z"),
];

type Call = { args: string[]; token: string; input: string };
async function bot(data: Pr, env: Pr = {}) {
  const dir = mkdtempSync(join(tmpdir(), "merge-bot-"));
  dirs.push(dir);
  const fake = join(dir, "gh");
  writeFileSync(fake, FAKE_GH);
  chmodSync(fake, 0o755);
  writeFileSync(
    join(dir, "data.json"),
    JSON.stringify({
      rules: required(...REQUIRED_CHECKS),
      mainRuns: GREEN_MAIN,
      ...data,
    })
  );
  const logFile = join(dir, "calls.jsonl");
  writeFileSync(logFile, "");
  let eventPath;
  if (env.payload) {
    eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(env.payload));
  }
  const fullEnv = {
    GITHUB_REPOSITORY: BACKEND,
    GITHUB_EVENT_NAME: "schedule",
    GH_TOKEN: "read-token",
    MERGE_BOT_TOKEN: "bot-token",
    ...(eventPath ? { GITHUB_EVENT_PATH: eventPath } : {}),
    ...env.vars,
  };
  const lines: string[] = [];
  const r = await runBot({
    env: fullEnv,
    argv: [],
    log: (l: string) => lines.push(l),
    gh: ghTransport({
      ghBin: fake,
      env: {
        ...process.env,
        FAKE_GH_DATA: join(dir, "data.json"),
        FAKE_GH_LOG: logFile,
      },
    }),
    // The resolver's results, as layout.mjs evaluateAll returns them.
    dependsOf: async (p: Pr) => (data.depends ?? {})[p.number] ?? [],
    now: NOW,
  });
  const calls: Call[] = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { r, calls, out: lines.join("\n") };
}
const isWrite = (c: Call) =>
  (c.args[1] === "graphql" &&
    /mutation/.test(c.args.find((a) => a.startsWith("query=")) ?? "")) ||
  (c.args[1] === "-X" && c.args[2] !== "GET");
const mutations = (calls: Call[], name: string) =>
  calls.filter(
    (c) =>
      c.args[1] === "graphql" &&
      (c.args.find((a) => a.startsWith("query=")) ?? "").includes(name)
  );
const varOf = (c: Call, k: string) =>
  c.args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
const greenOn = (h: string) =>
  greenRuns().map((c: Pr) => ({ ...c, head_sha: h }));

const queueData = () => ({
  prs: [
    pr({ number: 1, id: "PR_1", headRefOid: sha("1") }),
    pr({ number: 2, id: "PR_2", headRefOid: sha("2") }), // red
    pr({ number: 3, id: "PR_3", headRefOid: sha("3"), isDraft: true }),
    pr({
      number: 4,
      id: "PR_4",
      headRefOid: sha("4"),
      ...labelled("security"),
    }),
    pr({ number: 5, id: "PR_5", headRefOid: sha("5") }), // Depends-On open
    pr({ number: 6, id: "PR_6", headRefOid: sha("6") }), // edits ci.yml
  ],
  checks: {
    [sha("1")]: greenOn(sha("1")),
    [sha("2")]: greenOn(sha("2")).map((c: Pr) =>
      c.name === "Full suite" ? { ...c, conclusion: "failure" } : c
    ),
    [sha("3")]: greenOn(sha("3")),
    [sha("4")]: greenOn(sha("4")),
    [sha("5")]: greenOn(sha("5")),
    [sha("6")]: greenOn(sha("6")),
  },
  depends: { 5: [waitingOn(9)] },
  files: {
    6: [
      { filename: "packages/api/src/a.ts" },
      { filename: ".github/workflows/ci.yml" },
    ],
  },
});

describe(
  "merge-bot: the script, end to end, through `gh api`",
  { timeout: 30_000 },
  () => {
    it("enqueues the green eligible PRs with the APP's token and expectedHeadOid, the security fix first and jumping", async () => {
      const { r, calls, out } = await bot(queueData());
      expect(r).toMatchObject({ code: 0, enqueued: [4, 1] });
      expect(
        mutations(calls, "enqueuePullRequest").map((c) => [
          varOf(c, "id"),
          varOf(c, "oid"),
          varOf(c, "jump"),
          c.token,
        ])
      ).toEqual([
        ["PR_4", sha("4"), "true", "bot-token"],
        ["PR_1", sha("1"), "false", "bot-token"],
      ]);
      for (const c of calls.filter((c) => !isWrite(c)))
        expect(c.token).toBe("read-token");
      expect(out).toMatch(
        /#2 not enqueued: required checks: Full suite: failure/
      );
      expect(out).toMatch(/#3 not enqueued: draft/);
      expect(out).toMatch(/#5 not enqueued: Depends-On: waiting/);
      expect(out).toContain(
        `#6 not enqueued: ${INFRA_REASON} (.github/workflows/ci.yml)`
      );
    });

    it("a PR's files that cannot be read: not enqueued", async () => {
      const d = queueData();
      const { r, out } = await bot({
        ...d,
        prs: [d.prs[0]],
        unreadableFiles: [1],
      });
      expect(r.enqueued).toEqual([]);
      expect(out).toMatch(/#1 not enqueued: its files could not be read/);
    });

    it("main RED: only the jumpers enter (a main-red fix and the security fix), an ordinary green PR waits", async () => {
      const d = queueData();
      const fix = pr({
        number: 7,
        id: "PR_7",
        headRefOid: sha("7"),
        headRefName: "fix/main-red-x",
      });
      const { r, calls, out } = await bot({
        ...d,
        prs: [d.prs[0], d.prs[3], fix],
        checks: { ...d.checks, [sha("7")]: greenOn(sha("7")) },
        mainRuns: RED_MAIN,
      });
      expect(r.enqueued.sort()).toEqual([4, 7]);
      expect(
        mutations(calls, "enqueuePullRequest").every(
          (c) => varOf(c, "jump") === "true"
        )
      ).toBe(true);
      expect(out).toMatch(/#1 not enqueued: main is red/);
    });

    it("main red, the founder's override: every eligible PR enters", async () => {
      const d = queueData();
      const { r } = await bot(
        { ...d, prs: [d.prs[0]], mainRuns: RED_MAIN },
        { vars: { MERGE_BOT_ENQUEUE_WHILE_RED: "true" } }
      );
      expect(r.enqueued).toEqual([1]);
    });

    it("main's runs unreadable: only a security fix enters", async () => {
      const d = queueData();
      const { r, out } = await bot({
        ...d,
        prs: [d.prs[0], d.prs[3]],
        mainRuns: null,
      });
      expect(r.enqueued).toEqual([4]);
      expect(out).toMatch(/main's state is unknown/);
    });

    it("FAIL-SAFE: without the app's token it judges, logs, writes NOTHING and stays green", async () => {
      const { r, calls, out } = await bot(queueData(), {
        vars: { MERGE_BOT_TOKEN: "" },
      });
      expect(r.code).toBe(0);
      expect(r.enqueued).toEqual([]);
      expect(calls.filter(isWrite)).toEqual([]);
      expect(calls.length).toBeGreaterThan(3);
      expect(out).toMatch(/app token is absent/);
      expect(out).toMatch(/#1 WOULD enqueue/);
    });

    it("a dry run with the token writes nothing either", async () => {
      const { calls, out } = await bot(queueData(), {
        vars: { MERGE_BOT_DRY_RUN: "true" },
      });
      expect(calls.filter(isWrite)).toEqual([]);
      expect(out).toMatch(/#4 WOULD enqueue with jump \(security fix\)/);
    });

    it("a refused jump is retried without it", async () => {
      const d = queueData();
      const { r, calls, out } = await bot({
        ...d,
        prs: [d.prs[3]],
        refuseJump: true,
      });
      expect(r.enqueued).toEqual([4]);
      expect(
        mutations(calls, "enqueuePullRequest").map((c) => varOf(c, "jump"))
      ).toEqual(["true", "false"]);
      expect(out).toMatch(/could not jump the queue/);
    });

    it("'already queued' (a concurrent pass got there first) is success, not a red run", async () => {
      expect(
        ALREADY_QUEUED.test("Pull request is already in the merge queue")
      ).toBe(true);
      const d = queueData();
      const { r, out } = await bot({
        ...d,
        prs: [d.prs[0]],
        alreadyQueued: true,
      });
      expect(r).toMatchObject({ code: 0, enqueued: [1], failures: 0 });
      expect(out).toMatch(/#1 was already queued/);
    });

    it("a PR's CI run judges THAT PR only, and toggles no victim", async () => {
      const { r, calls } = await bot(queueData(), {
        vars: { GITHUB_EVENT_NAME: "workflow_run" },
        payload: {
          workflow_run: { id: 9, event: "pull_request", head_sha: sha("1") },
        },
      });
      expect(r.enqueued).toEqual([1]);
      expect(mutations(calls, "convertPullRequestToDraft")).toEqual([]);
    });

    const victimData = (over: Pr = {}) => ({
      prs: [
        pr({ number: 10, id: "PR_10", headRefOid: sha("a") }), // victim
        pr({ number: 11, id: "PR_11", headRefOid: sha("b") }), // already run again
        pr({ number: 12, id: "PR_12", headRefOid: sha("e") }), // its run passed
        pr({
          number: 13,
          id: "PR_13",
          headRefOid: sha("d"),
          isInMergeQueue: true,
        }), // queued
      ],
      mainRuns: [
        mainRun(3, "success", "2026-10-29T09:54:00Z"),
        mainRun(2, "failure", "2026-10-29T01:00:00Z"),
      ],
      prRuns: {
        [sha("a")]: [
          prRun({ id: 101, head_sha: sha("a") }),
          prRun({
            id: 100,
            head_sha: sha("a"),
            created_at: "2026-10-29T00:30:00Z",
          }),
        ],
        [sha("b")]: [prRun({ id: 102, head_sha: sha("b") })],
        [sha("e")]: [
          prRun({ id: 103, head_sha: sha("e"), conclusion: "success" }),
        ],
        [sha("d")]: [prRun({ id: 104, head_sha: sha("d") })],
      },
      markers: {
        [sha("b")]: [{ name: RERUN_CHECK_NAME, external_id: "main-green-3" }],
      },
      mainSha: MAIN_TIP,
      pulls: {
        10: { mergeable: true, merge_commit_sha: sha("f") },
        13: { mergeable: true, merge_commit_sha: sha("f") },
      },
      mergeBase: { [sha("f")]: MAIN_TIP },
      checks: {},
      ...over,
    });

    it("main back to green: the victim gets ONE fresh run (draft → ready, app token) and the marker; a queued PR is never toggled", async () => {
      const { r, calls, out } = await bot(victimData());
      expect(r).toMatchObject({ code: 0, rerun: [10] });
      const toggles = [
        ...mutations(calls, "convertPullRequestToDraft"),
        ...mutations(calls, "markPullRequestReadyForReview"),
      ];
      expect(toggles.map((c) => [varOf(c, "id"), c.token])).toEqual([
        ["PR_10", "bot-token"],
        ["PR_10", "bot-token"],
      ]);
      const marker = calls.filter((c) => c.args[2] === "POST");
      expect(marker).toHaveLength(1);
      expect(JSON.parse(marker[0].input)).toMatchObject({
        name: RERUN_CHECK_NAME,
        head_sha: sha("a"),
        external_id: "main-green-3",
        conclusion: "neutral",
      });
      expect(out).toMatch(
        /#11 not run again: already run again for main-green-3/
      );
      expect(calls.some((c) => (c.args[3] ?? "").includes("rerun"))).toBe(
        false
      );
    });

    it("the second sweep after it (marker posted) runs nothing again", async () => {
      const d = victimData();
      const { r } = await bot({
        ...d,
        markers: {
          ...d.markers,
          [sha("a")]: [{ name: RERUN_CHECK_NAME, external_id: "main-green-3" }],
        },
      });
      expect(r.rerun).toEqual([]);
    });

    it(`at most ${MAX_TOGGLES_PER_SWEEP} victims per sweep; the rest wait for the next`, async () => {
      const many = Array.from(
        { length: MAX_TOGGLES_PER_SWEEP + 2 },
        (_x, i) => {
          const h = (i + 1).toString(16).padStart(2, "0").repeat(20);
          return {
            pr: pr({ number: 30 + i, id: `PR_${30 + i}`, headRefOid: h }),
            h,
          };
        }
      );
      const { r, out } = await bot(
        victimData({
          prs: many.map((m) => m.pr),
          prRuns: Object.fromEntries(
            many.map((m) => [m.h, [prRun({ id: 200, head_sha: m.h })]])
          ),
          markers: {},
          pulls: Object.fromEntries(
            many.map((m) => [
              m.pr.number,
              { mergeable: true, merge_commit_sha: sha("f") },
            ])
          ),
        })
      );
      expect(r.rerun).toHaveLength(MAX_TOGGLES_PER_SWEEP);
      expect(out).toMatch(/wait for the next sweep/);
    });
  }
);

describe("merge-bot: riding, end to end", { timeout: 30_000 }, () => {
  const hold = (head: string) =>
    checkRun("Dependencies merged", "success", { head_sha: head });
  const rideData = (over: Pr = {}) => ({
    prs: [
      pr({
        number: 20,
        id: "PR_20",
        headRefOid: sha("2"),
        isInMergeQueue: true,
      }),
      pr({
        number: 21,
        id: "PR_21",
        headRefOid: sha("3"),
        ...labelled("security"),
      }), // rides #20
      pr({ number: 22, id: "PR_22", headRefOid: sha("4") }), // its dependency #23 is not queued
    ],
    checks: {
      [sha("3")]: [...greenOn(sha("3")), hold(sha("3"))],
      [sha("4")]: [...greenOn(sha("4")), hold(sha("4"))],
    },
    depends: { 21: [waitingOn(20)], 22: [waitingOn(23)] },
    rules: required(...REQUIRED_CHECKS, "Dependencies merged"),
    ...over,
  });

  it("the hold required: #21 is enqueued behind its queued #20, with no jump; #22 (dependency not queued) is not", async () => {
    const { r, calls, out } = await bot(rideData());
    expect(r.enqueued).toEqual([21]);
    expect(
      mutations(calls, "enqueuePullRequest").map((c) => [
        varOf(c, "id"),
        varOf(c, "jump"),
      ])
    ).toEqual([["PR_21", "false"]]);
    expect(out).toMatch(/#21 enqueued behind #20/);
    expect(out).toMatch(/#22 not enqueued: Depends-On: waiting/);
    expect(out).toMatch(/#20 not enqueued: already queued/);
  });

  it("the hold NOT required: nothing rides", async () => {
    const { r, out } = await bot(
      rideData({ rules: required(...REQUIRED_CHECKS) })
    );
    expect(r.enqueued).toEqual([]);
    expect(out).toMatch(
      /#21 not enqueued: Depends-On: #20 is in the merge queue, but riding is off/
    );
  });

  it("main's rules unreadable: nothing rides (fail-safe)", async () => {
    const { r, out } = await bot(rideData({ rules: undefined }));
    expect(r.enqueued).toEqual([]);
    expect(out).toMatch(/could not read main's required checks/);
  });

  it("every LIVE required check is required: the hold required and absent on a PR = not enqueued", async () => {
    const { r, out } = await bot({
      ...rideData(),
      prs: [pr({ number: 1, id: "PR_1", headRefOid: sha("1") })],
      checks: { [sha("1")]: greenOn(sha("1")) },
    });
    expect(r.enqueued).toEqual([]);
    expect(out).toMatch(
      /#1 not enqueued: required checks: Dependencies merged: none/
    );
  });
});

describe("merge-bot: what it must never do", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const script = readFileSync(join(HERE, "merge-bot.mjs"), "utf8");
  const wf = readFileSync(
    join(REPO, ".github/workflows/merge-bot.yml"),
    "utf8"
  );
  const code = script.replace(/^\s*(\*|\/\/).*$/gm, ""); // its code, not its prose
  it("sees what it scans (non-vacuous)", () => {
    expect(code).toContain("enqueuePullRequest");
    expect(wf).toContain("SYNAP_MERGE_BOT_KEY");
  });
  it.each([
    ["merge a PR", /mergePullRequest|pr["', ]+merge|\/merge["'`]/],
    ["bypass as an admin", /--admin|bypass/i],
    ["re-run the stale merge", /rerun-failed-jobs|\/rerun\b|run rerun/],
    [
      "update a branch or push",
      /update-branch|updatePullRequestBranch|git push/,
    ],
  ])("its code never does: %s", (_n, re) => {
    expect(code).not.toMatch(re);
  });
  it("the bot job reads its secrets from environment ci-bots (branch policy: main), never repo-wide", () => {
    const job = wf.slice(wf.indexOf("\n  bot:"));
    expect(job.length).toBeGreaterThan(100);
    expect(/^ {4}environment: ([\w-]+)\s*$/m.exec(job)?.[1]).toBe("ci-bots");
    expect(job.indexOf("environment: ci-bots")).toBeLessThan(
      job.indexOf("steps:")
    );
  });
  it("the workflow never touches the Release App key and mints the bot on backend only", () => {
    expect(wf).not.toMatch(/SYNAP_RELEASE_APP/);
    expect(wf).toMatch(/app-id: \$\{\{ secrets\.SYNAP_MERGE_BOT_APP_ID \}\}/);
    const mint = wf.slice(wf.indexOf("Mint the merge bot token"));
    expect(/repositories: (\S+)/.exec(mint)?.[1]).toBe("backend");
    expect(mint).toMatch(/continue-on-error: true/);
  });
  it("a merge-queue CI run starts no bot run (it would replace the pending pass)", () => {
    const on = wf.slice(
      wf.indexOf("  workflow_run:"),
      wf.indexOf("  schedule:")
    );
    expect(on).toMatch(/branches-ignore:\n\s+- "gh-readonly-queue\/\*\*"/);
  });
  it("one concurrency group for every pass (never two enqueues of one PR at once)", () => {
    expect(
      /^concurrency:\n(?:\s+#.*\n)*\s+group: (\S+)\s*$/m.exec(wf)?.[1]
    ).toBe("merge-bot");
  });
  it("listens to the workflow ci.yml is named, and sparse-checks-out every file the script imports", () => {
    const ciName = /^name: (.+)$/m.exec(
      readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8")
    )?.[1];
    expect(wf).toContain(`workflows: [${ciName}]`);
    const sparse = (/sparse-checkout: \|\n((?:\s+\S+\n)+)/.exec(wf)?.[1] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const need = new Set<string>();
    const walk = (rel: string) => {
      if (need.has(rel)) return;
      need.add(rel);
      const src = readFileSync(join(REPO, rel), "utf8");
      for (const m of src.matchAll(/from "(\.\.?\/[^"]+)"/g))
        walk(resolve("/", dirname(rel), m[1]).slice(1));
      // A file read beside the module (layout.mjs's LAYOUT_FILE). Sees only
      // this `join(dirname(fileURLToPath(import.meta.url)), "<f>.json")` form.
      for (const m of src.matchAll(
        /join\(\s*dirname\(fileURLToPath\(import\.meta\.url\)\),\s*"([\w.-]+\.json)"\s*\)/g
      ))
        need.add(resolve("/", dirname(rel), m[1]).slice(1));
    };
    walk("scripts/ci/merge-bot.mjs");
    expect(need.size).toBeGreaterThanOrEqual(6);
    expect(need).toContain("scripts/pod-observation.mjs");
    for (const f of need) expect(sparse).toContain(f);
  });
});
