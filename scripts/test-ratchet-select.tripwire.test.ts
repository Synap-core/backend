/**
 * The PR selection (lane L8) through the REAL judge: `test-ratchet.mjs
 * --reports=DIR --select=FILE`, reading exactly what the shards write in
 * select mode: one vitest report per planned run (`select:<dir>#shard<k>`),
 * the run's listing (`<id>.list.json`) and one done marker per shard. The
 * plan comes from planSelection over this checkout's real tripwires, so a
 * judge that expects another id, or misses a tripwire, goes red here before
 * it goes red on a PR. Each file's verdict follows the baseline (a known-red
 * file is reported red), so "fixed" passes only when every file is where the
 * judge expects it.
 *
 * Also pins the planner: shard count from the measured cost (1 when small,
 * capped when large), every planned file in exactly one run, files of a dir
 * with no suite dropped unless they are tripwires.
 *
 * What it does not cover: that vitest really runs the files (the shards do,
 * on CI) and the shard count's real wall-clock fit (the PR replay measures
 * that against the shard plan's costs).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SELECTION_MAX_SHARDS,
  loadShardPlan,
  ownerDir,
  planSelection,
  selectionProblems,
  shardDoneId,
  // @ts-expect-error — plain ESM script, no declarations
} from "./test-ratchet-shards.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { discoverTripwires, isTripwire } from "./tripwire-discovery.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { suiteDirs } from "./ci/affected.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts/test-ratchet.mjs");
const baseline = new Set(
  readFileSync(join(REPO, "scripts/test-ratchet-baseline.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("|")[0].trim())
);
const tripwires: string[] = discoverTripwires(REPO).map((f: string) =>
  relative(REPO, f)
);
const SUITES: string[] = suiteDirs(REPO);
const plan = loadShardPlan();
// Test files per owning dir, as ci-changes.mjs counts them (the cost model
// spreads a package's measured wall over its files).
const countByDir: Record<string, number> = {};
for (const f of execFileSync("git", ["ls-files"], {
  cwd: REPO,
  encoding: "utf8",
})
  .split("\n")
  .filter((x) => /\.test\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(x)))
  countByDir[ownerDir(f)] = (countByDir[ownerDir(f)] ?? 0) + 1;
const EXTRA = [
  "packages/api/src/services/capabilities/install-layers.test.ts",
  "apps/pod-admin/app/(admin)/review/_lib/review-rows.test.ts",
  "packages/governance-policy/src/agent-hand-off.test.ts",
];

const report = (files: string[], red: string[] = [], passed = 100) => ({
  numTotalTests: files.length + 100,
  numPassedTests: passed,
  testResults: files.map((f) => {
    const failed = baseline.has(f) || red.includes(f);
    return {
      name: join(REPO, f),
      status: failed ? "failed" : "passed",
      message: failed ? "red" : "",
      assertionResults: [{ status: failed ? "failed" : "passed" }],
    };
  }),
});
const fileName = (id: string, ext = "json") =>
  `${id.replace(/[^a-z0-9]+/gi, "_")}.${ext}`;

type Sel = {
  shards: number;
  runs: { id: string; dir: string; shard: number; files: string[] }[];
  tests: string[];
  dropped: string[];
};

/** Write what the shards write for this plan (with faults), then judge. */
function judge(
  sel: Sel,
  {
    dropReport,
    dropMarker,
    dropFile,
    notListed,
    emptyList,
    packageListed = 5,
    red = [],
    vacuousRun,
    echo,
  }: {
    dropReport?: string;
    dropMarker?: number;
    dropFile?: string;
    notListed?: string;
    emptyList?: string;
    /** emptyList's package listed with no filter: how many files (null: failed) */
    packageListed?: number | null;
    red?: string[];
    /** this run's report: tests, and not one passed */
    vacuousRun?: string;
    /** `file` also appears, passing, in the report of run `into` */
    echo?: { file: string; into: string };
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-select-"));
  try {
    const selPath = join(dir, "selection.json");
    writeFileSync(selPath, JSON.stringify(sel));
    for (const r of sel.runs) {
      const listed =
        r.id === emptyList ? [] : r.files.filter((f) => f !== notListed);
      writeFileSync(
        join(dir, fileName(r.id, "list.json")),
        JSON.stringify(
          r.id === emptyList ? { listed, packageListed } : { listed }
        )
      );
      if (r.id === dropReport || r.id === emptyList) continue;
      const files = r.files.filter((f) => f !== dropFile && f !== notListed);
      const own = report(
        files,
        red.filter((f) => r.files.includes(f)),
        r.id === vacuousRun ? 0 : 100
      );
      if (echo?.into === r.id)
        own.testResults.push(report([echo.file]).testResults[0]);
      writeFileSync(join(dir, fileName(r.id)), JSON.stringify(own));
    }
    for (let k = 1; k <= sel.shards; k++)
      if (k !== dropMarker)
        writeFileSync(
          join(dir, `${shardDoneId(k)}.json`),
          JSON.stringify({ shard: k })
        );
    const r = spawnSync(
      process.execPath,
      [SCRIPT, `--reports=${dir}`, `--select=${selPath}`],
      {
        cwd: REPO,
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" },
      }
    );
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const planOf = (tests: string[], opts = {}) =>
  planSelection({
    tests,
    suiteDirs: SUITES,
    isTripwire,
    plan,
    countByDir,
    ...opts,
  }) as Sel;

/** A suite with no tripwire and no --passWithNoTests: a run of one file. */
function loneRun() {
  const pkg = (d: string) =>
    JSON.parse(readFileSync(join(REPO, d, "package.json"), "utf8"));
  const lone = execFileSync("git", ["ls-files"], {
    cwd: REPO,
    encoding: "utf8",
  })
    .split("\n")
    .find(
      (f) =>
        /\.test\.ts$/.test(f) &&
        SUITES.includes(ownerDir(f)) &&
        !/--passWithNoTests/.test(pkg(ownerDir(f)).scripts?.test ?? "") &&
        !tripwires.some((t) => ownerDir(t) === ownerDir(f))
    )!;
  expect(lone).toBeTruthy();
  const sel = planOf([...tripwires, lone]);
  const run = sel.runs.find((x) => x.files.includes(lone))!;
  expect(run.files).toEqual([lone]);
  return { sel, run };
}

describe("test-ratchet --select: the PR selection, judged as CI judges it", () => {
  const small = planOf([...tripwires, ...EXTRA]);
  const large = planOf([...tripwires, ...EXTRA], { budgetSeconds: 60 });

  it("the scan is not vacuous", () => {
    expect(tripwires.length).toBeGreaterThan(300);
    expect(SUITES).toContain("packages/api");
    expect(small.runs.length).toBeGreaterThan(3);
  });

  it("a complete selection, 1 shard and N shards: green", () => {
    expect(small.shards).toBe(1);
    expect(large.shards).toBeGreaterThan(1);
    for (const sel of [small, large]) {
      const r = judge(sel);
      expect(r.out).toContain("test ratchet OK");
      expect(r.status).toBe(0);
    }
  });

  it("a shard with no done marker: red, never a partial green", () => {
    const r = judge(large, { dropMarker: 2 });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`shard 2/${large.shards} wrote no done marker`);
  });

  it("a planned run with no report: red", () => {
    const run = large.runs.find((x) => x.shard === large.shards)!;
    const r = judge(large, { dropReport: run.id });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`[no-report]`);
    expect(r.out).toContain(run.id);
  });

  it("a planned file vitest listed but no report holds: red (select-unrun)", () => {
    const r = judge(small, { dropFile: EXTRA[0] });
    expect(r.status).toBe(1);
    expect(r.out).toContain("[select-unrun]");
  });

  it("a planned file its package's config does not collect: listed, not red", () => {
    const r = judge(small, { notListed: EXTRA[0] });
    expect(r.out).toContain("[not-collected]");
    expect(r.status).toBe(0);
  });

  it("a run whose listing is empty needs no report", () => {
    // A test of a suite with no tripwire: its run holds no tripwire (one
    // must always run), so its listing may be empty.
    const { sel, run } = loneRun();
    const r = judge(sel, { emptyList: run.id });
    expect(r.out).toContain("[not-collected]");
    expect(r.status).toBe(0);
  });

  it("a package whose config collects NOTHING is red, as main's full mode is", () => {
    // Its files list [] and the package listed with no filter is empty too
    // (a broken `include`); without --passWithNoTests main is red on it.
    const { sel, run } = loneRun();
    for (const packageListed of [0, null]) {
      const r = judge(sel, { emptyList: run.id, packageListed });
      expect(r.status, String(packageListed)).toBe(1);
      expect(r.out).toContain("[vacuous]");
      expect(r.out).toContain(run.dir);
    }
  });

  it("a tripwire the plan dropped: red (the decision promised every tripwire)", () => {
    const broken = {
      ...small,
      runs: small.runs.map((x) => ({
        ...x,
        files: x.files.filter((f) => f !== tripwires[0]),
      })),
    };
    const r = judge(broken);
    expect(r.status).toBe(1);
    expect(r.out).toContain("[selection]");
    expect(r.out).toContain("tripwire(s) planned in no run");
  });

  it("a new failure in a selected file: red", () => {
    const r = judge(small, { red: [EXTRA[2]] });
    expect(r.status).toBe(1);
    expect(r.out).toContain("[new-failure]");
    expect(r.out).toContain(EXTRA[2]);
  });

  it("a run with tests and not one passing: red (vacuous), as in the full mode", () => {
    const run = small.runs.find((x) => x.files.some((f) => !baseline.has(f)))!;
    const r = judge(small, { vacuousRun: run.id });
    expect(r.status).toBe(1);
    expect(r.out).toContain("[vacuous]");
    expect(r.out).toContain(run.id);
  });

  it("a file two runs reached: its red is never overwritten by a later green", () => {
    // EXTRA[0] is red in its own run and passes in a run collected AFTER it
    // (vitest's file filters are substrings: one file can run twice).
    const own = large.runs.findIndex((x) => x.files.includes(EXTRA[0]));
    const later = large.runs[large.runs.length - 1];
    expect(large.runs.indexOf(later)).toBeGreaterThan(own);
    const r = judge(large, {
      red: [EXTRA[0]],
      echo: { file: EXTRA[0], into: later.id },
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("[new-failure]");
    expect(r.out).toContain(EXTRA[0]);
  });

  it("a plan whose runs are not its selection, or that runs a file twice: red", () => {
    const twice = {
      ...small,
      runs: small.runs.map((x, i) =>
        i === 0 ? { ...x, files: [...x.files, small.runs[1].files[0]] } : x
      ),
    };
    expect(selectionProblems(twice, tripwires).join(" ")).toContain(
      "planned in two runs"
    );
    const extra = {
      ...small,
      tests: [...small.tests, "packages/x/gone.test.ts"],
    };
    expect(selectionProblems(extra, tripwires).join(" ")).toContain(
      "the runs are not the selection"
    );
    const r = judge(twice);
    expect(r.status).toBe(1);
    expect(r.out).toContain("[selection]");
  });

  it("a PR's FULL tier planned as a selection keeps the full mode's file floor", () => {
    // The same small plan, marked full: far below 2,000 files, so red;
    // unmarked (a selection), green. Per-package floors are not applied: the
    // full mode counts what vitest collects, the plan names files (see
    // affected.mjs COMMITTED_PLAN).
    const sel = planOf([...tripwires, ...EXTRA]);
    expect(judge(sel).status).toBe(0);
    const r = judge({ ...sel, full: true });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/only \d+ test files ran \(floor 2000\)/);
    expect(r.out).not.toContain("[below-floor]");
  });

  it("a missing selection file fails the judge (it never judges something else)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-select-"));
    try {
      const p = join(dir, "selection.json");
      writeFileSync(p, "{}");
      unlinkSync(p);
      const r = spawnSync(
        process.execPath,
        [SCRIPT, `--reports=${dir}`, `--select=${p}`],
        { cwd: REPO, encoding: "utf8" }
      );
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("test-ratchet shards: planning a PR selection", () => {
  it("1 shard when small, more when large, never above the cap", () => {
    expect(planOf(tripwires).shards).toBe(1);
    // The whole api suite at a 60 s budget would want ~45 shards: the cap holds.
    const many = planOf(
      [...tripwires, ...Object.keys(plan.api).map((f) => `packages/api/${f}`)],
      { budgetSeconds: 60 }
    );
    expect(many.shards).toBe(SELECTION_MAX_SHARDS);
    // The budget decides: half the budget, about twice the shards.
    const a = planOf([...tripwires, ...EXTRA], { budgetSeconds: 120 });
    const b = planOf([...tripwires, ...EXTRA], { budgetSeconds: 60 });
    expect(b.shards).toBeGreaterThan(a.shards);
  });

  it("every planned file runs in exactly one run, every run is named for its dir and shard", () => {
    const sel = planOf([...tripwires, ...EXTRA], { budgetSeconds: 60 });
    const planned = sel.runs.flatMap((r) => r.files);
    expect(new Set(planned).size).toBe(planned.length);
    expect(new Set(planned)).toEqual(new Set([...tripwires, ...EXTRA]));
    expect(selectionProblems(sel, tripwires)).toEqual([]);
    // Balanced: no shard is empty.
    for (let k = 1; k <= sel.shards; k++)
      expect(
        sel.runs.some((r) => r.shard === k),
        `shard ${k}`
      ).toBe(true);
  });

  it("a test of a dir with no suite runs nowhere (on main either); a tripwire there still runs", () => {
    const sel = planOf([
      "packages/test-e2e/src/core-flows.test.ts",
      "scripts/dev-pr-gap-filler.test.mjs",
      ...tripwires,
    ]);
    expect(sel.dropped).toEqual([
      "packages/test-e2e/src/core-flows.test.ts",
      "scripts/dev-pr-gap-filler.test.mjs",
    ]);
    expect(sel.tests).toEqual(expect.arrayContaining(tripwires));
  });

  it("deterministic: the same input plans the same runs", () => {
    const a = planOf([...EXTRA, ...tripwires], { budgetSeconds: 60 });
    const b = planOf([...tripwires, ...EXTRA].reverse(), { budgetSeconds: 60 });
    expect(b).toEqual(a);
  });
});
