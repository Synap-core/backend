/**
 * ci-changes.mjs decides which CI checks a change may skip. A wrong "skip" lets
 * a change merge unchecked, so this file pins the decision, guards the one
 * list that can go stale (the docs-only paths, which must be paths no test
 * reads), and reads ci.yml to prove every required check RUNS and passes a
 * skipped tier only through an explicit, logged "Not affected" step.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import {
  BASELINE,
  SELF_FULL,
  SUITE_NEUTRAL,
  TEST_FILE,
  loadGraph,
  selectTier,
  suiteDirs,
} from "./ci/affected.mjs";
import {
  SELECTION_MAX_SHARDS,
  loadShardPlan,
  ownerDir,
  selectionProblems,
  // @ts-expect-error — plain ESM script, no declarations
} from "./test-ratchet-shards.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { isTripwire } from "./tripwire-discovery.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { TEST_FILE as GRAPH_TEST_FILE } from "./ci/import-graph.mjs";
import {
  QUEUE_REUSE_CHECKS,
  TESTED_STEP,
  decide,
  isDocsOnly,
  isImageInput,
  queuePrNumber,
  changedFiles,
  reusableRun,
  shardMatrix,
  withPlan,
  suitesPassed,
  summary,
  // @ts-expect-error — plain ESM script, no declarations
} from "./ci-changes.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const none = () => [];
// The real graph of this checkout: the decision under test is the one CI makes
// (ci-changes.mjs tierOfCheckout: the tier, then its shard plan).
const graph = loadGraph(REPO, isTripwire);
const SUITES: string[] = suiteDirs(REPO);
const countByDir: Record<string, number> = {};
for (const f of graph.imports.files as string[])
  if (TEST_FILE.test(f))
    countByDir[ownerDir(f)] = (countByDir[ownerDir(f)] ?? 0) + 1;
const allSuiteTests = (graph.imports.files as string[]).filter(
  (f) => TEST_FILE.test(f) && (isTripwire(f) || SUITES.includes(ownerDir(f)))
);
const shardPlan = loadShardPlan();
const everyTest = (graph.imports.files as string[]).filter((f) =>
  TEST_FILE.test(f)
);
// The production wrapper (ci-changes.mjs withPlan), not a copy of it.
const tier = (files: string[]) =>
  withPlan(selectTier(files, graph), {
    everyTest,
    suiteDirs: SUITES,
    plan: shardPlan,
    countByDir,
  });
const pr = (files: string[] | null, extra = {}) =>
  decide({
    event: "pull_request",
    headRef: "fix/x",
    draft: false,
    files,
    siblingTests: none,
    tier,
    ...extra,
  });

describe("ci-changes: every check runs unless a narrow match says otherwise", () => {
  it("a push or a manual run checks everything (tier 2: main)", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      const d = decide({
        event,
        headRef: "negctl/x",
        draft: true,
        files: ["docs/x.md"],
        siblingTests: none,
        tier,
      });
      expect([d.gate, d.image, d.suites, d.e2e, d.scope, d.negctl]).toEqual([
        true,
        true,
        true,
        true,
        "full",
        false,
      ]);
    }
  });

  it("unknown changed files check everything", () => {
    const d = pr(null);
    expect([d.gate, d.image, d.suites, d.e2e, d.scope]).toEqual([
      true,
      true,
      true,
      true,
      "full",
    ]);
  });

  it("no dependency graph (it failed to load): the full suite, never a guess", () => {
    const d = pr(["apps/pod-admin/app/x.tsx"], { tier: null });
    expect([d.suites, d.scope, d.e2e]).toEqual([true, "full", true]);
    expect(d.reason).toContain("could not be read");
  });

  // The image tiers (founder, 2026-10-29, decision ffaafe15): a PR or a
  // queue entry runs the Docker image and the deploy tests only when it
  // touches what they are made of; a push to main always does (the push row
  // above). Each row is one the old deny-list (IMAGE_NEUTRAL) or an
  // always-on rule decides differently.
  it("a source-only PR: no image (application source, its tests, a CI script, a tsconfig)", () => {
    for (const files of [
      ["packages/api/src/routers/x.ts", "packages/api/src/routers/x.test.ts"],
      // Not application source: the old deny-list ran the image for these.
      ["scripts/ci/affected.mjs"],
      ["packages/api/tsconfig.json"],
      ["scripts/smoke-test.sh"],
    ]) {
      const d = pr(files);
      expect([d.gate, d.image, d.suites], files.join()).toEqual([
        true,
        false,
        true,
      ]);
      expect(d.reason).toContain("Docker image and deploy tests not affected");
      expect(d.imageWhy).toContain("IMAGE_INPUTS");
    }
  });

  it("a Dockerfile, a lockfile or anything else the image is made of: the image", () => {
    for (const f of [
      "deploy/Dockerfile",
      "apps/pod-admin/Dockerfile",
      ".dockerignore",
      "pnpm-lock.yaml",
      "package.json",
      "packages/api/package.json",
      "packages/database/migrations/0400_x.sql",
      "packages/database/src/schema/x.ts",
      "packages/api/src/services/skills/runner/index.ts",
      "packages/api/tsup.provision.config.ts",
      "skills/synap/SKILL.md",
      "kratos/kratos.yml",
      "deploy/__tests__/x.test.sh",
      "synap",
      "scripts/skill-runner-sandbox-smoke.mjs",
      "scripts/ci/image-smoke.sh",
      ".github/workflows/ci.yml",
      ".github/workflows/docker-publish.yml",
    ]) {
      expect(isImageInput(f), f).toBe(true);
      const d = pr(["packages/api/src/x.ts", f]);
      expect(d.image, f).toBe(true);
      expect(d.imageWhy, f).toBe("");
    }
  });

  it("unknown changed files and every push run the image", () => {
    expect(pr(null).image).toBe(true);
    for (const event of ["push", "workflow_dispatch", "schedule"])
      expect(
        decide({
          event,
          headRef: "main",
          draft: false,
          files: ["packages/api/src/x.ts"],
          siblingTests: none,
          tier,
        }).image,
        event
      ).toBe(true);
  });

  it("a merge-queue entry follows the same rule, in the light run and in the tier", () => {
    const q = (files: string[] | null, suitesPassed: boolean) =>
      decide({
        event: "merge_group",
        headRef: "",
        draft: false,
        files,
        siblingTests: none,
        tier,
        queue: { pr: 480, headSha: "fc6b05901", suitesPassed, reuse: null },
      });
    for (const passed of [true, false]) {
      expect(q(["packages/api/src/x.ts"], passed).image, `${passed}`).toBe(
        false
      );
      expect(q(["packages/api/src/x.ts"], passed).reason).toContain(
        "not affected"
      );
      expect(q(["deploy/Dockerfile"], passed).image, `${passed}`).toBe(true);
      expect(q(["pnpm-lock.yaml"], passed).image, `${passed}`).toBe(true);
      expect(q(null, passed).image, `${passed}`).toBe(true);
    }
  });

  // DERIVED: what deploy/Dockerfile copies and builds, and every repo path a
  // deploy test reads, must be an image input. A new COPY or a new
  // "$HERE/<path>" in a deploy test joins the check by existing.
  describe("IMAGE_INPUTS covers what the image and the deploy tests read", () => {
    const dockerfile = readFileSync(join(REPO, "deploy/Dockerfile"), "utf8");
    // `x/*` → `x/x`: a sample path under a glob.
    const sample = (p: string) => p.replace(/\*/g, "x");

    it("every source deploy/Dockerfile copies, the manifests it reads and the configs it builds", () => {
      const sources: string[] = [];
      for (const m of dockerfile.matchAll(/^COPY (.+)$/gm)) {
        const words = m[1].split(/\s+/).filter((w) => !w.startsWith("--"));
        const from = /--from=(\w+)/.exec(m[1])?.[1];
        for (const w of words.slice(0, -1)) {
          if (w === ".") continue; // the whole context: built, then copied
          if (from === "manifests") continue; // the stage below
          const path = from ? w.replace(/^\/app\//, "") : w;
          // Build outputs of `pnpm turbo build`, `pnpm deploy`: their inputs
          // are application source, which the Build step already checks.
          if (
            /(^|\/)dist(\/|$)/.test(path) ||
            /^deploy\/(api|realtime)$/.test(path)
          )
            continue;
          sources.push(path);
        }
      }
      const manifests = /for f in ([^;]+); do/.exec(dockerfile)?.[1] ?? "";
      sources.push(...manifests.split(/\s+/).filter(Boolean));
      for (const m of dockerfile.matchAll(/--config ([\w./-]+)/g))
        sources.push(`packages/api/${m[1]}`);
      // Non-vacuity: the scan still sees a literal sample of each form.
      expect(sources).toEqual(
        expect.arrayContaining([
          "pnpm-lock.yaml",
          "kratos",
          "packages/database/migrations/*.sql",
          "skills",
          "apps/*/package.json",
          "packages/api/tsup.provision.config.ts",
        ])
      );
      for (const src of sources) {
        const path = sample(src);
        const isDir =
          existsSync(join(REPO, path)) &&
          statSync(join(REPO, path)).isDirectory();
        const probe = isDir ? `${path}/x` : path;
        expect(isImageInput(probe), `${src} (deploy/Dockerfile)`).toBe(true);
      }
    });

    it("every repo path a deploy test reads", () => {
      const tests = execFileSync(
        "git",
        ["ls-files", "deploy/__tests__/*.test.sh"],
        {
          cwd: REPO,
          encoding: "utf8",
        }
      )
        .split("\n")
        .filter(Boolean);
      expect(tests.length).toBeGreaterThanOrEqual(30);
      const read = new Map<string, string>();
      for (const t of tests) {
        const src = readFileSync(join(REPO, t), "utf8");
        for (const m of src.matchAll(
          /\$\{?HERE\}?\/([A-Za-z0-9_.][A-Za-z0-9_./-]*)/g
        )) {
          const rel = m[1].replace(/\/$/, "");
          // HERE is the repo root in most tests, deploy/ in a few.
          for (const base of ["", "deploy/"]) {
            const path = normalize(`${base}${rel}`).replace(/\/$/, "");
            if (path.startsWith("..")) continue; // a sibling repo
            if (existsSync(join(REPO, path)) && !read.has(path))
              read.set(path, t);
          }
        }
      }
      // Non-vacuity: paths outside deploy/ that tests are known to read.
      expect([...read.keys()]).toEqual(
        expect.arrayContaining([
          "synap",
          "kratos",
          "apps/api/src/index.ts",
          "scripts/check-migrations-forward-only.mjs",
          ".github/workflows/docker-publish.yml",
          "packages/api/src/services/skills/runner",
        ])
      );
      // A directory a test reads under a NAME it computes ("$HERE/<dir>/$x").
      // What it reads there is pinned by the rows below, not by the scan.
      const COMPUTED_UNDER: Record<string, string[]> = {
        // install-manifest-signature: the workflow named in the signer identity.
        ".github/workflows": [".github/workflows/docker-publish.yml"],
        // kratos-recovery-config: `for page in recovery settings/security`.
        "apps/pod-admin/app": [
          "apps/pod-admin/app/recovery/page.tsx",
          "apps/pod-admin/app/settings/security/page.tsx",
        ],
      };
      // NOT COVERED, on purpose (measured): caddy-routes greps the WHOLE API
      // source for a header neither caddy nor the API may send
      // (X-XSS-Protection). Making apps/api/src an image input would run the
      // image for most PRs; a PR that adds that header is caught by main's
      // post-merge run and before any release.
      const SCANS_SOURCE: Record<string, string> = {
        "apps/api/src": "deploy/__tests__/caddy-routes.test.sh",
      };
      for (const [path, test] of read) {
        if (COMPUTED_UNDER[path]) {
          for (const f of COMPUTED_UNDER[path])
            expect(isImageInput(f), `${f} (${test})`).toBe(true);
          continue;
        }
        if (SCANS_SOURCE[path]) {
          expect(test).toBe(SCANS_SOURCE[path]);
          continue;
        }
        const probe = statSync(join(REPO, path)).isDirectory()
          ? `${path}/x`
          : path;
        expect(isImageInput(probe), `${path} (read by ${test})`).toBe(true);
      }
    });
  });

  it("a draft runs the Release gate, not the suites, and holds the suite checks red", () => {
    const d = pr(["packages/api/src/x.ts"], { draft: true });
    expect([d.gate, d.suites, d.e2e, d.draftHold]).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("docs only skips everything; one non-doc file brings it back", () => {
    const docs = pr(["docs/DEVELOPER.md", "README.md"]);
    expect([docs.gate, docs.suites, docs.e2e, docs.scope]).toEqual([
      false,
      false,
      false,
      "none",
    ]);
    const mixed = pr(["docs/DEVELOPER.md", "CLAUDE.md"]);
    expect([mixed.gate, mixed.suites, mixed.scope]).toEqual([
      true,
      true,
      "selected",
    ]);
  });

  it("a docs-only file beside package source never widens the tier", () => {
    const src = "apps/pod-admin/app/(admin)/review/_lib/review-rows.ts";
    const d = pr([src, "README.md"]);
    expect(d.scope).toBe("selected");
    expect(d.selection?.tests).toEqual(pr([src]).selection?.tests);
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
      tier,
    });
    expect([d.gate, d.image, d.suites, d.e2e, d.negctl]).toEqual([
      false,
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

// The PR tier on the real graph (lane L8, 2026-10-29): test FILES the change
// reaches, every tripwire, root config full. Each row rules out a looser or a
// tighter rule: "the touched package and its dependents" (the tier before L8)
// fails row 1's exclusions; "only direct importers" fails row 1b; "shared
// code runs everything" fails row 2; "anything outside a package is full"
// fails row 3; "root config is a path like any other" fails row 4.
const nonTripwire = (tests: string[]) => tests.filter((f) => !isTripwire(f));
const tests = (d: { selection: { tests: string[] } | null }) =>
  d.selection?.tests ?? [];

describe("ci-changes: the PR tier on the real graph", () => {
  it("1. a pod-admin module: its importers' tests and every tripwire, no other package, no e2e", () => {
    const d = pr(["apps/pod-admin/app/(admin)/review/_lib/review-rows.ts"]);
    expect([d.scope, d.suites, d.e2e]).toEqual(["selected", true, false]);
    expect(tests(d)).toEqual(
      expect.arrayContaining([
        "apps/pod-admin/app/(admin)/review/_lib/review-rows.test.ts",
        "apps/pod-admin/app/(admin)/review/_lib/review-groups.test.tsx",
        ...graph.tripwires,
      ])
    );
    // Not the package: a pod-admin test that does not import it stays out.
    const all = graph.imports.files.filter(
      (f: string) => f.startsWith("apps/pod-admin/") && TEST_FILE.test(f)
    );
    expect(nonTripwire(tests(d)).length).toBeLessThan(
      nonTripwire(all).length / 2
    );
    expect(
      nonTripwire(tests(d)).every((f) => f.startsWith("apps/pod-admin/"))
    ).toBe(true);
    expect(d.reason).toContain("every tripwire");
  });

  it("1b. a library: its own tests and the tests of every importer, transitively", () => {
    const d = pr(["packages/governance-policy/src/index.ts"]);
    expect(d.scope).toBe("selected");
    for (const f of [
      // its own package's tests
      "packages/governance-policy/src/agent-hand-off.test.ts",
      // a test that imports it directly
      "packages/api/src/routers/proposals/__tests__/execute-executors.test.ts",
      // a test that reaches it through packages/api/src/access/grant-read.ts
      "packages/api/src/access/grant-read-coverage.tripwire.test.ts",
    ])
      expect(tests(d), f).toContain(f);
  });

  it("2. packages/types, packages/database and packages/core go through the graph", () => {
    for (const [f, reached] of [
      [
        "packages/types/src/vocabulary/index.ts",
        "packages/types/src/vocabulary/vocabulary.test.ts",
      ],
      [
        "packages/database/src/schema/entities.ts",
        "packages/database/src/migrations-0319.pglite.test.ts",
      ],
      ["packages/core/src/index.ts", "apps/api/src/admin-event-stream.test.ts"],
      [
        // a test that walks its own package's src (review #522, finding 5)
        "packages/api/src/services/tracks/tracks-service.ts",
        "packages/api/src/notifications/notification-producer-allowlist.test.ts",
      ],
    ]) {
      const d = pr([f]);
      expect(d.scope, f).toBe("selected");
      expect(tests(d), `${f} → ${reached}`).toContain(reached);
      expect(tests(d).length, f).toBeLessThan(allSuiteTests.length);
    }
  });

  it("3. skills/, deploy/, .github/, scripts/ and read docs: the tests that read them, no full suite", () => {
    for (const [f, reached] of [
      [
        "skills/synap/SKILL.md",
        "packages/api/src/routers/hub-protocol/rest/skills-crud.create-projection.test.ts",
      ],
      [
        "deploy/docker-compose.yml",
        "apps/api/src/middleware/rate-limit-deploy-wiring.test.ts",
      ],
      [
        ".github/workflows/merge-bot.yml",
        "scripts/ci/merge-bot.tripwire.test.ts",
      ],
      ["scripts/preflight.mjs", "scripts/preflight.tripwire.test.ts"],
    ]) {
      const d = pr([f]);
      expect(d.scope, f).toBe("selected");
      expect(tests(d), `${f} → ${reached}`).toContain(reached);
      // Rules out "a narrowed path runs everything": far below the suite.
      expect(tests(d).length, f).toBeLessThan(allSuiteTests.length / 3);
    }
  });

  it("4. root config and the test runner run the full suite (each one, alone)", () => {
    for (const f of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "turbo.json",
      ".node-version",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
      "scripts/test-ratchet.mjs",
      "scripts/test-ratchet-shards.mjs",
      "scripts/test-ratchet-retry.mjs",
      "scripts/tripwire-discovery.mjs",
      "scripts/test-floors.json",
      // the selector: a PR must never run its own weakened selection
      "scripts/ci-changes.mjs",
      "scripts/ci/affected.mjs",
      "scripts/ci/import-graph.mjs",
      "scripts/strip-comments.mjs",
      // the shard jobs: database service, env, migrate step, install layout
      ".github/workflows/ci.yml",
      ".github/actions/monorepo-setup/action.yml",
      // every DATABASE_URL test runs on the migrated schema
      "packages/database/migrations/0372_inbound_deliveries_and_observation_keys.sql",
      // fail-safe: unknown outside paths, and a dir that is not a package
      ".husky/pre-push",
      "kratos-unknown/x",
      "packages/ghost/src/x.ts",
    ]) {
      const d = pr([f]);
      expect([d.scope, d.suites, d.e2e], f).toEqual(["full", true, true]);
      if (SELF_FULL.some((re: RegExp) => re.test(f))) {
        // The runner, the selector, ci.yml: never a plan the changed code
        // computed; the committed 4-shard plan, in the full mode.
        expect(d.selection, f).toBeNull();
        expect(shardMatrix(d), f).toEqual([1, 2, 3, 4]);
      } else {
        // Every test file, planned by cost (lead decision, 29 Oct): more
        // than the main plan's 4 shards, never more than the cap.
        expect(d.selection?.full, f).toBe(true);
        expect(shardMatrix(d).length, f).toBeGreaterThan(4);
        expect(shardMatrix(d).length, f).toBeLessThanOrEqual(
          SELECTION_MAX_SHARDS
        );
      }
    }
    // Both kinds are in the list above (non-vacuity of the two branches).
    expect(
      SELF_FULL.some((re: RegExp) => re.test("scripts/ci-changes.mjs"))
    ).toBe(true);
    expect(SELF_FULL.some((re: RegExp) => re.test("pnpm-lock.yaml"))).toBe(
      false
    );
    // A self-change beside a lockfile change: still the committed plan.
    expect(
      pr(["pnpm-lock.yaml", "scripts/ci/import-graph.mjs"]).selection
    ).toBeNull();
    // The control: a narrowed script beside them is not full on its own.
    expect(pr(["scripts/pod-observation.mjs"]).scope).toBe("selected");
    for (const f of [
      "CLAUDE.md",
      ".claude/rules/x.md",
      "docs/decisions/README.md",
    ])
      expect(pr([f]).scope, f).toBe("selected");
  });

  it("4b. a package's tsconfig or build config reaches every importer, not just its own tests", () => {
    for (const f of [
      "packages/database/tsconfig.json",
      "packages/database/tsup.config.ts",
    ]) {
      const d = pr([f]);
      expect(d.scope, f).toBe("selected");
      // api tests load @synap/database through exports → dist.
      expect(tests(d), f).toContain(
        "packages/api/src/routers/agent-runs.summary.test.ts"
      );
      expect(nonTripwire(tests(d)).length, f).toBeGreaterThan(1000);
    }
  });

  it("4c. the changed paths list a rename's old path too (git diff --no-renames)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-changes-git-"));
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      }).trim();
    git("init", "-q");
    writeFileSync(join(dir, "old.yml"), "a: 1\nb: 2\nc: 3\n");
    git("add", ".");
    git("commit", "-qm", "one");
    const base = git("rev-parse", "HEAD");
    git("mv", "old.yml", "new.yml");
    git("commit", "-qm", "rename");
    expect(changedFiles(base, "HEAD", dir).sort()).toEqual([
      "new.yml",
      "old.yml",
    ]);
  });

  it("5a. one test-file pattern: the graph's, in the selection and in ci-changes", () => {
    expect(TEST_FILE).toBe(GRAPH_TEST_FILE);
    // ci-changes' own use (a negctl branch's test files) sees .cts and .cjs.
    const d = decide({
      event: "pull_request",
      headRef: "negctl/x",
      draft: false,
      files: ["packages/a/src/x.test.cts", "scripts/y.test.cjs"],
      siblingTests: none,
      tier,
    });
    expect(d.negctlTests).toEqual([
      "packages/a/src/x.test.cts",
      "scripts/y.test.cjs",
    ]);
  });

  it("5. a changed TEST file runs itself, not its package", () => {
    const f = "packages/types/src/vocabulary/goal-words.test.ts";
    const d = pr([f]);
    expect(d.scope).toBe("selected");
    expect(tests(d)).toContain(f);
    expect(tests(d)).not.toContain(
      "packages/types/src/vocabulary/sign-in-way-labels.test.ts"
    );
  });

  it("6. the known-red baseline changed: every file it names runs, before and after", () => {
    const d = selectTier([BASELINE], graph, {
      baseBaseline: [
        "packages/api/src/services/capabilities/install-layers.test.ts",
      ],
    });
    expect(d.scope).toBe("selected");
    expect(d.tests).toEqual(
      expect.arrayContaining([
        ...graph.baseline,
        "packages/api/src/services/capabilities/install-layers.test.ts",
      ])
    );
    expect(graph.baseline.length).toBeGreaterThan(5);
  });

  it("7. docs only: no suite, an explicit not-affected verdict", () => {
    const d = pr(["docs/DEVELOPER.md"]);
    expect([d.scope, d.suites, d.e2e, d.gate]).toEqual([
      "none",
      false,
      false,
      false,
    ]);
    expect(summary(d, ["docs/DEVELOPER.md"])).toContain(
      "| Full suite | not affected |"
    );
  });

  it("API e2e runs only for the API surface", () => {
    for (const [f, e2e] of [
      ["packages/api/src/routers/proposals.ts", true],
      ["packages/api/src/middleware/auth.ts", true],
      ["apps/api/src/index.ts", true],
      ["packages/test-e2e/src/core-flows.test.ts", true],
      ["packages/hub-protocol/src/index.ts", true],
      ["packages/api/src/services/capabilities/install-layers.ts", false],
      ["apps/pod-admin/app/x.tsx", false],
    ] as const)
      expect(pr([f]).e2e, f).toBe(e2e);
  });

  it("a selection comes with its shard plan: 1 shard when small, more when large, never above the cap", () => {
    const small = pr(["apps/pod-admin/app/(admin)/review/_lib/review-rows.ts"]);
    expect(small.selection?.shards).toBe(1);
    const large = pr(["packages/governance-policy/src/index.ts"]);
    expect(large.selection?.shards).toBeGreaterThan(1);
    expect(large.selection?.shards).toBeLessThanOrEqual(SELECTION_MAX_SHARDS);
    // Every planned file in exactly one run; every tripwire planned.
    for (const d of [small, large]) {
      const planned = d.selection!.runs.flatMap(
        (r: { files: string[] }) => r.files
      );
      expect(new Set(planned).size).toBe(planned.length);
      expect(selectionProblems(d.selection, graph.tripwires)).toEqual([]);
    }
    expect(shardMatrix(small)).toEqual([1]);
    // A full PR: every test file in up to 8 cost-sized shards. A push to
    // main keeps the committed 4-shard plan, whatever it changed.
    const full = pr(["package.json"]);
    expect(full.selection?.tests.length).toBe(
      full.selection!.runs.flatMap((r: { files: string[] }) => r.files).length
    );
    expect(full.selection!.tests).toEqual(
      expect.arrayContaining(allSuiteTests)
    );
    expect(shardMatrix(full)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const pushed = decide({
      event: "push",
      files: ["package.json"],
      siblingTests: none,
      tier,
    });
    expect([pushed.scope, pushed.selection]).toEqual(["full", null]);
    expect(shardMatrix(pushed)).toEqual([1, 2, 3, 4]);
  });
});

// Finding 606c00e3 (27 Oct) and the main reds of 28-29 Oct: each test file
// that went red on main after a merge, and the PR that broke it (named by the
// fix PR or commit: #446 in #451, #476 in #489, #495 in #505, #482/#483 in
// #509, #365 in 08027767c). The culprit's REAL file list (gh api
// pulls/<n>/files) must select the file it broke. Tripwires are not listed:
// every PR runs every tripwire.
describe("ci-changes: every main red of 27-29 Oct is selected by the PR that caused it", () => {
  const { prs } = JSON.parse(
    readFileSync(join(REPO, "scripts/ci/finding-606c00e3-prs.json"), "utf8")
  ) as { prs: Record<string, string[]> };
  const { culprits } = JSON.parse(
    readFileSync(join(REPO, "scripts/ci/main-red-culprits.json"), "utf8")
  ) as {
    culprits: { pr: string; red: string; files: string[]; evidence: string }[];
  };
  const BROKEN_606 = [
    "packages/api/src/routers/proposals/__tests__/podwide-executor-approval.test.ts",
    "packages/api/src/routers/proposals/__tests__/batch-approve-registry.test.ts",
    "packages/api/src/routers/proposals/executors/__tests__/workspace-template-update-approve.pglite.test.ts",
    "packages/api/src/services/capabilities/install-layers.test.ts",
  ];
  const runs = (d: ReturnType<typeof pr>, f: string) =>
    d.scope === "full" || tests(d).includes(f);

  it("the fixtures hold the PRs, and every red file exists", () => {
    expect(Object.keys(prs).sort()).toEqual(
      ["#278", "#323", "#350", "#357", "#364", "#365"].sort()
    );
    expect(prs["#278"].length).toBe(162);
    expect(culprits.length).toBeGreaterThanOrEqual(6);
    for (const f of [...BROKEN_606, ...culprits.map((c) => c.red)])
      expect(
        execFileSync("git", ["ls-files", f], {
          cwd: REPO,
          encoding: "utf8",
        }).trim(),
        f
      ).toBe(f);
  });

  it("606c00e3: every broken file runs for at least one of the six, batch-approve-registry for #365", () => {
    for (const f of BROKEN_606)
      expect(
        Object.values(prs).some((files) => runs(pr(files), f)),
        f
      ).toBe(true);
    expect(
      runs(
        pr(prs["#365"]),
        "packages/api/src/routers/proposals/__tests__/batch-approve-registry.test.ts"
      )
    ).toBe(true);
  });

  it.each(culprits.map((c) => [c.pr, c.red, c] as const))(
    "%s selects %s",
    (_n, red, c) => {
      const d = pr(c.files.filter((f) => !isDocsOnly(f)));
      expect(d.suites).toBe(true);
      expect(runs(d, red), c.evidence).toBe(true);
    }
  );
});

describe("ci-changes: the real graph is derived, not empty", () => {
  it("reads every workspace package, the import graph and the cross-package test references", () => {
    expect(graph.dirs.length).toBeGreaterThan(20);
    expect(graph.imports.files.length).toBeGreaterThan(5000);
    expect(graph.refs.length).toBeGreaterThan(50);
    expect(graph.tripwires.length).toBeGreaterThan(300);
    // Tripwires run on every PR, so they never widen the tier through refs.
    expect(graph.refs.some((r: { file: string }) => isTripwire(r.file))).toBe(
      false
    );
  });

  const namesFile = (text: string, file: string) =>
    new RegExp(
      `['"\`/]${file.split("/").pop()!.replaceAll(".", "\\.")}['"\`]`
    ).test(text);

  it("no test file reads a SUITE_NEUTRAL path", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const neutral = tracked.filter((f) =>
      SUITE_NEUTRAL.some((re: RegExp) => re.test(f))
    );
    expect(neutral.length).toBeGreaterThan(2);
    const tests = tracked.filter(
      (f) =>
        /\.test\.(ts|tsx|mts|mjs|js|sh)$/.test(f) &&
        f !== "scripts/ci-changes.tripwire.test.ts"
    );
    const hits: string[] = [];
    for (const t of tests) {
      const text = readFileSync(join(REPO, t), "utf8");
      // The directory, and each file under it by its bare name between
      // quotes or after a slash (`events.json`, never `events.jsonl`).
      if (text.includes("docs/reference"))
        hits.push(`${t} reads docs/reference`);
      for (const f of neutral)
        if (namesFile(text, f)) hits.push(`${t} names ${f}`);
    }
    expect(hits).toEqual([]);
    // Self-check: the name match still sees a quoted file name, and only it.
    const f = "docs/reference/mcp-tools.json";
    expect([
      namesFile('read("mcp-tools.json")', f),
      namesFile('"mcp-tools.jsonl"', f),
    ]).toEqual([true, false]);
  });
});

// Same tree: a queue entry whose tree is the tree its PR's all-green run
// tested re-runs nothing. Each row rules out a looser rule: reuse on a
// different tree (main moved), on a run where a required check was skipped
// (GitHub counts that green), or on checks gathered from two runs.
describe("ci-changes: the merge queue", () => {
  const T = "a".repeat(40);
  const U = "b".repeat(40);
  const url = (id: number) =>
    `https://github.com/Synap-core/backend/actions/runs/${id}/job/1`;
  const check = (
    name: string,
    conclusion: string | null = "success",
    runId = 40776509345,
    status = "completed"
  ) => ({ name, status, conclusion, details_url: url(runId) });
  const allGreen = () => QUEUE_REUSE_CHECKS.map((n: string) => check(n));
  const queued = (
    reuse: unknown,
    files: string[] | null = null,
    suitesPassed = false
  ) =>
    decide({
      event: "merge_group",
      headRef: "",
      draft: false,
      files,
      siblingTests: none,
      tier,
      queue: { pr: 471, headSha: "bc328a622", suitesPassed, reuse },
    });

  // The light queue run (#428, kept under the tiers): the PR's own Full
  // suite and API e2e passed, so the entry re-checks the Release gate only,
  // and the two suite checks pass out loud ("Not affected", this reason).
  it("the PR's own suites passed, main moved: the light run (Release gate only)", () => {
    const d = queued(
      { runId: 1, testedCommit: "c", testedTree: T, queueTree: U },
      ["packages/types/src/x.ts"],
      true
    );
    expect([d.gate, d.suites, d.scope, d.e2e, d.reuse]).toEqual([
      true,
      false,
      "none",
      false,
      undefined,
    ]);
    expect(d.reason).toContain("#471's own Full suite and API e2e passed");
    expect(summary(d, ["packages/types/src/x.ts"])).toContain(
      "| Full suite | not affected |"
    );
  });

  it("same tree beats the light run: nothing re-runs", () => {
    const d = queued(
      { runId: 1, testedCommit: "c", testedTree: T, queueTree: T },
      null,
      true
    );
    expect([d.gate, d.reuse]).toEqual([false, true]);
  });

  it.each([
    [
      "both success",
      [
        ["Full suite", "success"],
        ["API e2e", "success"],
      ],
      true,
    ],
    [
      "a skipped suite",
      [
        ["Full suite", "skipped"],
        ["API e2e", "success"],
      ],
      false,
    ],
    [
      "a neutral e2e",
      [
        ["Full suite", "success"],
        ["API e2e", "neutral"],
      ],
      false,
    ],
    [
      "a red suite",
      [
        ["Full suite", "failure"],
        ["API e2e", "success"],
      ],
      false,
    ],
    ["API e2e missing", [["Full suite", "success"]], false],
    [
      "still running",
      [
        ["Full suite", null],
        ["API e2e", "success"],
      ],
      false,
    ],
  ] as const)("suitesPassed: %s", (_l, rows, want) => {
    expect(
      suitesPassed(
        rows.map(([name, conclusion]) => ({
          name,
          conclusion,
          status: conclusion ? "completed" : "in_progress",
        }))
      )
    ).toBe(want);
    expect(suitesPassed(null as never)).toBe(false);
  });

  it("all 4 required checks success on one run: that run", () => {
    expect(reusableRun(allGreen())).toBe(40776509345);
  });

  it.each([
    ["a skipped suite (a draft run)", ["Full suite", "skipped"]],
    ["a neutral check", ["Reference docs are current", "neutral"]],
    ["a red Release gate", ["Release gate", "failure"]],
    ["a check still running", ["API e2e", null]],
  ])("%s: no run to reuse", (_l, [name, conclusion]) => {
    const runs = allGreen().map((r: { name: string }) =>
      r.name === name
        ? check(
            name,
            conclusion,
            40776509345,
            conclusion ? "completed" : "in_progress"
          )
        : r
    );
    expect(reusableRun(runs)).toBeNull();
  });

  it("a missing check, two runs, or no run id: no run to reuse", () => {
    expect(reusableRun(allGreen().slice(1))).toBeNull();
    const two = allGreen();
    two[0] = check(two[0].name, "success", 1);
    expect(reusableRun(two)).toBeNull();
    expect(
      reusableRun(allGreen().map((r: object) => ({ ...r, details_url: "" })))
    ).toBeNull();
    expect(reusableRun(null as never)).toBeNull();
  });

  it("identical tree on an all-green run: nothing re-runs, and it says which run", () => {
    const d = queued({
      runId: 40776509345,
      testedCommit: "0a42579a9" + "0".repeat(31),
      testedTree: T,
      queueTree: T,
    });
    expect([d.gate, d.image, d.suites, d.e2e, d.reuse]).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(d.reason).toContain("40776509345");
    expect(d.reason).toContain("#471");
  });

  it("main moved and the PR's own suites did not both pass: the Release gate and the FULL suite, on the combined tree", () => {
    const d = queued(
      { runId: 1, testedCommit: "c", testedTree: T, queueTree: U },
      ["apps/pod-admin/app/x.tsx"]
    );
    expect(d.reuse).not.toBe(true);
    // Never a selection here: nothing vouches for one (review of #522).
    expect([d.gate, d.suites, d.scope, d.e2e]).toEqual([
      true,
      true,
      "full",
      true,
    ]);
    expect(d.selection).toBeNull();
    // ... on the merge queue's 4-shard plan, never a cost-sized one.
    expect(shardMatrix(d)).toEqual([1, 2, 3, 4]);
    expect(d.reason).toContain("on the tree it will land");
  });

  it("a queue entry touching root config runs everything", () => {
    const d = queued(null, ["pnpm-lock.yaml"]);
    expect([d.gate, d.suites, d.scope, d.e2e]).toEqual([
      true,
      true,
      "full",
      true,
    ]);
  });

  it("a queue entry whose diff could not be read runs everything", () => {
    const d = queued(null, null);
    expect([d.gate, d.suites, d.scope, d.e2e]).toEqual([
      true,
      true,
      "full",
      true,
    ]);
  });

  it("a queue entry never holds (negctl, stack, draft are PR states)", () => {
    const d = decide({
      event: "merge_group",
      headRef: "negctl/x",
      baseRef: "feat/y",
      draft: true,
      files: ["packages/api/src/x.ts"],
      siblingTests: none,
      tier,
    });
    expect([d.hold, d.negctl, d.suites]).toEqual(["", false, true]);
  });

  it("a malformed or missing tree never matches", () => {
    for (const reuse of [
      { runId: 1, testedTree: undefined, queueTree: undefined },
      { runId: 1, testedTree: "", queueTree: "" },
      { runId: null, testedTree: T, queueTree: T },
    ])
      expect(queued(reuse).reuse, JSON.stringify(reuse)).not.toBe(true);
  });

  it("only a merge-queue run reuses", () => {
    const d = decide({
      event: "push",
      headRef: "",
      draft: false,
      files: null,
      siblingTests: none,
      tier,
      queue: {
        pr: 471,
        headSha: "x",
        reuse: { runId: 1, testedTree: T, queueTree: T },
      },
    });
    expect([d.gate, d.suites, d.reuse]).toEqual([true, true, undefined]);
  });

  it("the reused checks are the ruleset's required checks", () => {
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
    expect([...QUEUE_REUSE_CHECKS].sort()).toEqual([...required].sort());
  });

  it("reads the PR from the queue branch, and nothing else", () => {
    expect(
      queuePrNumber("refs/heads/gh-readonly-queue/main/pr-402-550070005abc")
    ).toBe(402);
    expect(queuePrNumber("gh-readonly-queue/main/pr-7-abc")).toBe(7);
    expect(queuePrNumber("feat/pr-402-x")).toBeNull();
    expect(queuePrNumber(undefined)).toBeNull();
  });

  it("every run names the commit it tested, in the step the queue reads", () => {
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    const changes = ci.slice(
      ci.indexOf("\n  changes:\n"),
      ci.indexOf("\n  preflight:\n")
    );
    expect(changes).toContain("- name: Tested commit ${{ github.sha }}");
    expect(changes).toContain("reuse: ${{ steps.decide.outputs.reuse }}");
    expect(changes).toContain(
      "QUEUE_HEAD_SHA: ${{ github.event.merge_group.head_sha }}"
    );
    expect(changes).toContain(
      "QUEUE_BASE_SHA: ${{ github.event.merge_group.base_sha }}"
    );
    expect(changes).toMatch(/^ {6}actions: read$/m);
    // the rendered name parses
    expect(TESTED_STEP.exec(`Tested commit ${T}`)?.[1]).toBe(T);
    expect(TESTED_STEP.exec("Tested commit ${{ github.sha }}")).toBeNull();
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

describe("ci-changes: holds never read as passed", () => {
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
    if (d.draftHold) expect([d.suites, d.e2e]).toEqual([false, false]);
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
          tier,
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

  it("the decision reaches the job outputs and the run's summary (the script's own files)", () => {
    const run = (draft: string) => {
      const dir = mkdtempSync(join(tmpdir(), "ci-changes-"));
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
          GITHUB_OUTPUT: join(dir, "out"),
          GITHUB_STEP_SUMMARY: join(dir, "summary"),
          SELECTION_OUT: join(dir, "selection.json"),
        },
      });
      return {
        out: readFileSync(join(dir, "out"), "utf8").split("\n"),
        summary: readFileSync(join(dir, "summary"), "utf8"),
        selection: existsSync(join(dir, "selection.json"))
          ? JSON.parse(readFileSync(join(dir, "selection.json"), "utf8"))
          : null,
      };
    };
    const draft = run("true");
    expect(draft.out).toEqual(
      expect.arrayContaining(["suites=false", "draft_hold=true", "e2e=false"])
    );
    expect(draft.summary).toContain("| Full suite | red (draft");
    // An empty diff is not docs-only: the tier selects nothing to widen from,
    // and every output a judge reads is present.
    const ready = run("false");
    for (const key of [
      "suites",
      "scope",
      "shards",
      "shard_count",
      "selected",
      "select",
      "e2e",
      "reason",
    ])
      expect(
        ready.out.some((l) => l.startsWith(`${key}=`)),
        key
      ).toBe(true);
    expect(ready.out).toEqual(expect.arrayContaining(["draft_hold=false"]));
    // An empty diff selects every tripwire, in one shard, written to the file
    // the shards and the judge read; a draft writes none.
    expect(ready.out).toEqual(
      expect.arrayContaining([
        "scope=selected",
        "shards=[1]",
        "shard_count=1",
        "select=true",
      ])
    );
    expect(ready.selection?.shards).toBe(1);
    expect(selectionProblems(ready.selection, graph.tripwires)).toEqual([]);
    expect(draft.selection).toBeNull();
    // An empty diff touches nothing the image is made of: the image jobs pass
    // through "Not affected", with the reason they print.
    expect(ready.out).toEqual(expect.arrayContaining(["image=false"]));
    expect(ready.out.find((l) => l.startsWith("image_reason="))).toContain(
      "IMAGE_INPUTS"
    );
    expect(ready.summary).toContain(
      "| Docker image + deploy tests | skipped: not affected (IMAGE_INPUTS)"
    );
    expect(ready.summary).toContain("### What this run checks");
  }, 60_000);
});

// ci.yml read as text: the jobs block, split per job at two-space indent.
describe("ci.yml: every required check runs, and passes a skipped tier only out loud", () => {
  const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
  const jobs = ci
    .slice(ci.indexOf("\njobs:\n"))
    .split(/\n(?= {2}[A-Za-z0-9_-]+:\s*\n)/)
    .slice(1)
    .map((block) => ({
      id: /^ {2}([A-Za-z0-9_-]+):/m.exec(block)?.[1] ?? "",
      name: (/^ {4}name: (.+)$/m.exec(block)?.[1] ?? "").replace(/^"|"$/g, ""),
      if: /^ {4}if: (.+)$/m.exec(block)?.[1] ?? "",
      env: /^ {4}env:\n((?: {6}.*\n)+)/m.exec(block)?.[1] ?? "",
      matrix: /^ {6}matrix:/m.test(block),
      steps: (block.split(/^ {4}steps:\n/m)[1] ?? "")
        .split(/^ {6}- /m)
        .slice(1),
      block,
    }));
  const HOLD = "needs.changes.outputs.hold != ''";
  const NEGCTL_HOLD = "needs.changes.outputs.hold == 'negctl'";
  // DERIVED: the jobs named like the ruleset's required checks.
  const required = jobs.filter((j) => QUEUE_REUSE_CHECKS.includes(j.name));

  it("the scan finds the 4 required checks, once each", () => {
    expect(jobs.length).toBeGreaterThan(10);
    expect(required.map((j) => j.name).sort()).toEqual(
      [...QUEUE_REUSE_CHECKS].sort()
    );
  });

  it("no required check can be skipped by its `if:` (#441)", () => {
    for (const j of required) expect(j.if, j.name).toBe("${{ !cancelled() }}");
  });

  // Each required check: a step that passes WITHOUT doing the work exists,
  // runs only on a SUCCESSFUL `changes` that named an explicit value (an
  // empty output — `changes` crashed — never reaches it), never on a hold or
  // a red preflight, and writes why to the run's summary. Every step after it
  // that does the work is gated on RUN_WORK, which is true when `changes`
  // failed.
  it.each([
    ["Release gate", "needs.changes.outputs.gate == 'false'"],
    ["Full suite", "needs.changes.outputs.suites == 'false'"],
    ["API e2e", "needs.changes.outputs.e2e == 'false'"],
    ["Reference docs are current", "needs.changes.outputs.reuse == 'true'"],
  ])("%s: an explicit, logged pass; the work gated", (name, decision) => {
    const j = required.find((x) => x.name === name);
    expect(j, name).toBeDefined();
    const i = j!.steps.findIndex((s) => /^name: (Not affected|Reused)/.test(s));
    expect(i, `${name}: no "Not affected" step`).toBeGreaterThan(0);
    const pass = j!.steps[i];
    expect(pass).toContain("needs.changes.result == 'success'");
    expect(pass).toContain(decision);
    expect(pass).toContain("needs.preflight.outputs.hold != 'true'");
    expect(pass).toContain("GITHUB_STEP_SUMMARY");
    expect(pass).not.toMatch(/exit [1-9]/);
    expect(j!.env, name).toMatch(
      /RUN_WORK: \$\{\{ (needs\.changes\.result != 'success' \|\| )?needs\.changes\.outputs\.\w+ != '(false|true)' \}\}/
    );
    if (name !== "Reference docs are current")
      expect(j!.env).toContain("needs.changes.result != 'success'");
    // Every step after the pass does work: each one is gated.
    const after = j!.steps.slice(i + 1);
    expect(after.length, name).toBeGreaterThan(0);
    for (const s of after)
      expect(s, `${name}: ${s.split("\n")[0]}`).toMatch(
        /\n\s+if: \$\{\{ .*env\.RUN_WORK == 'true'.* \}\}\n/
      );
  });

  it("the shards and the judge read the same selection and shard count", () => {
    const shard = jobs.find((j) => j.id === "full-suite-shard");
    const judge = jobs.find((j) => j.name === "Full suite");
    const SELECT =
      "TEST_RATCHET_SELECT: ${{ needs.changes.result == 'success' && needs.changes.outputs.select == 'true' && format('{0}/selection/selection.json', runner.temp) || '' }}";
    const COUNT =
      "${{ needs.changes.result == 'success' && needs.changes.outputs.shard_count || 4 }}";
    for (const j of [shard, judge]) {
      expect(j?.block).toContain(SELECT);
      expect(j?.block).toContain(COUNT);
      // Each downloads the one selection file the changes job uploads.
      expect(j?.block).toMatch(
        /download-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+name: selection\n/
      );
    }
    // The shard matrix is the decision's own, the plan's 4 when it failed.
    expect(shard?.block).toContain(
      "shard: ${{ fromJSON(needs.changes.result == 'success' && needs.changes.outputs.shards || '[1,2,3,4]') }}"
    );
    expect(shard?.block).toContain(`--shard=\${{ matrix.shard }}/${COUNT}`);
    expect(judge?.block).toContain(`--shards=${COUNT}`);
    const changes = jobs.find((j) => j.name === "What changed");
    for (const o of [
      "scope",
      "shards",
      "shard_count",
      "selected",
      "select",
      "e2e",
      "reason",
    ])
      expect(changes?.block).toContain(
        `${o}: \${{ steps.decide.outputs.${o} }}`
      );
    expect(changes?.block).toContain(
      "SELECTION_OUT: ${{ runner.temp }}/selection/selection.json"
    );
    expect(changes?.block).toMatch(
      /upload-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+name: selection\n\s+path: \$\{\{ runner\.temp \}\}\/selection\/selection\.json\n\s+if-no-files-found: error/
    );
  });

  it("the changes job exports hold and passes the base ref", () => {
    const changes = jobs.find((j) => j.name === "What changed");
    expect(changes?.block).toContain("hold: ${{ steps.decide.outputs.hold }}");
    expect(changes?.block).toContain(
      "image_reason: ${{ steps.decide.outputs.image_reason }}"
    );
    expect(changes?.block).toContain("BASE_REF: ${{ github.base_ref }}");
  });

  it("ci.yml runs for a pull request to ANY base", () => {
    const on = ci.slice(ci.indexOf("\non:\n"), ci.indexOf("\njobs:\n"));
    const prBlock = /^ {2}pull_request:\n((?: {4}.*\n| *#.*\n)*)/m.exec(on);
    expect(prBlock).not.toBeNull();
    expect(prBlock?.[1]).not.toMatch(/^ {4}branches:/m);
  });

  it("the Release gate's FIRST step fails a negctl hold", () => {
    const gate = jobs.find((j) => j.name === "Release gate");
    const first = gate?.steps[0] ?? "";
    expect(first).toContain(`if: \${{ ${NEGCTL_HOLD} }}`);
    expect(first).toMatch(/\n\s+exit 1\n/);
  });

  it("Reference docs reports red for a negctl branch instead of skipping", () => {
    const job = jobs.find((j) => j.name === "Reference docs are current");
    expect(job?.steps[0]).toContain("startsWith(github.head_ref, 'negctl/')");
    expect(job?.steps[0]).toMatch(/\n\s+exit 1\n/);
  });

  it("both suite checks fail a hold at their FIRST step", () => {
    for (const name of ["Full suite", "API e2e"]) {
      const first = jobs.find((j) => j.name === name)?.steps[0] ?? "";
      expect(first, name).toContain(`if: \${{ ${HOLD} }}`);
      expect(first, name).toMatch(/\n\s+exit 1\n/);
    }
  });

  it("a red main names the commits since the last all-green main", () => {
    const job = jobs.find((j) => j.id === "red-main");
    expect(job, "job exists").toBeDefined();
    expect(job?.if).toContain("github.event_name == 'push'");
    expect(job?.if).toContain("github.ref == 'refs/heads/main'");
    expect(job?.if).toContain("!cancelled()");
    for (const id of [
      "release-gate",
      "full-suite",
      "api-e2e",
      "reference-docs",
    ])
      expect(job?.if).toContain(`needs.${id}.result != 'success'`);
    expect(job?.block).toContain(
      'node scripts/ci/release-gate-wait.mjs --culprits "$REPO" "$SHA"'
    );
    expect(job?.block).toMatch(/fetch-depth: \d+/);
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
