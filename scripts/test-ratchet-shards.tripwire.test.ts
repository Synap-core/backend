/**
 * The Full suite runs as N shard jobs and one judge. A shard plan that drops a
 * package, or a merge that reads a partial run as complete, would turn the gate
 * green over tests that never ran. This pins both.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import {
  SHARDED_DIRS,
  assignApiFiles,
  hashShard,
  loadShardPlan,
  mergeShardReports,
  mustRunFiles,
  parseShard,
  planFits,
  runsForShard,
  shardReportId,
  soloRuns,
} from "./test-ratchet-shards.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const runs = [
  { id: "packages/api", dir: "packages/api", args: [] },
  { id: "packages/database", dir: "packages/database", args: [] },
  { id: "packages/jobs", dir: "packages/jobs", args: ["--passWithNoTests"] },
];

describe("test-ratchet shards", () => {
  it("parses k/N and refuses anything else", () => {
    expect(parseShard(undefined)).toBeNull();
    expect(parseShard("2/4")).toEqual({ k: 2, n: 4 });
    for (const bad of ["0/4", "5/4", "2", "a/b", "1/0"])
      expect(() => parseShard(bad), bad).toThrow();
  });

  it("every package runs exactly once across the shards; packages/api is split in each", () => {
    const n = 4;
    const plan = Array.from({ length: n }, (_, i) =>
      runsForShard(runs, { k: i + 1, n })
    );
    for (const r of runs) {
      const appearances = plan.flat().filter((x) => x.dir === r.dir);
      if (SHARDED_DIRS.includes(r.dir)) {
        expect(appearances.map((x) => x.args.at(-1))).toEqual([
          "--shard=1/4",
          "--shard=2/4",
          "--shard=3/4",
          "--shard=4/4",
        ]);
        expect(new Set(appearances.map((x) => x.reportId)).size).toBe(n);
      } else {
        expect(appearances).toHaveLength(1);
        expect(plan[0]).toContainEqual(r);
      }
    }
    expect(SHARDED_DIRS).toContain("packages/api");
  });

  it("without --shard the plan is unchanged", () => {
    expect(runsForShard(runs, null)).toBe(runs);
  });

  it("a merge of complete shards sums them; one missing shard is no report", () => {
    const a = {
      testResults: [{ name: "a" }],
      numTotalTests: 3,
      numPassedTests: 2,
    };
    const b = {
      testResults: [{ name: "b" }, { name: "c" }],
      numTotalTests: 5,
      numPassedTests: 5,
    };
    expect(mergeShardReports([a, b])).toEqual({
      testResults: [{ name: "a" }, { name: "b" }, { name: "c" }],
      numTotalTests: 8,
      numPassedTests: 7,
    });
    expect(mergeShardReports([a, null, b])).toBeNull();
    expect(mergeShardReports([])).toBeNull();
    expect(shardReportId("packages/api", 2)).not.toBe(
      shardReportId("packages/api", 3)
    );
  });
});

// The split by measured time (scripts/ci/shard-plan.json): every packages/api
// file and every other package runs in exactly one shard, whatever the plan
// says or forgets; a plan that does not fit falls back to vitest's --shard.
describe("test-ratchet shards: the measured plan", () => {
  const apiFiles = [
    "src/a.test.ts",
    "src/b.test.ts",
    "src/c.test.ts",
    "src/new-file.test.ts", // not in the plan: placed by hash
    "src/x/src/a.test.ts", // contains "src/a.test.ts": vitest's filter reaches it
  ];
  const plan = {
    shards: 4,
    packages: { "packages/database": 2 },
    api: {
      "src/a.test.ts": [1, 10],
      "src/b.test.ts": [3, 10],
      "src/c.test.ts": [4, 10],
      "src/gone.test.ts": [2, 10], // deleted since: dropped
      "src/x/src/a.test.ts": [2, 1],
    },
  };
  const shardsOf = (p: unknown, files: string[] | null) =>
    Array.from({ length: 4 }, (_, i) =>
      runsForShard(runs, { k: i + 1, n: 4 }, { plan: p, apiFiles: files })
    );

  it("every listed api file runs in exactly one shard, every package once", () => {
    // Shard 2 gets only the substring host's neighbour; give it a file so the
    // plan is valid for all four shards.
    const files = [...apiFiles, "src/two.test.ts"];
    const p = { ...plan, api: { ...plan.api, "src/two.test.ts": [2, 1] } };
    const shards = shardsOf(p, files);
    const apiArgs = shards.map(
      (s) =>
        s.find((r: { dir: string }) => r.dir === "packages/api")?.args ?? []
    );
    const ran = apiArgs.flat().filter((a: string) => !a.startsWith("-"));
    expect([...ran].sort()).toEqual([...files].sort());
    expect(new Set(ran).size).toBe(ran.length);
    expect(apiArgs[1]).not.toContain("src/gone.test.ts");
    for (const r of runs.filter((x) => !SHARDED_DIRS.includes(x.dir))) {
      const where = shards
        .map((s, i) =>
          s.some((x: { dir: string }) => x.dir === r.dir) ? i + 1 : 0
        )
        .filter(Boolean);
      expect(where, r.dir).toHaveLength(1);
    }
    // planned package → its shard; an unplanned one → shard 1
    expect(shards[1].map((r: { dir: string }) => r.dir)).toContain(
      "packages/database"
    );
    expect(shards[0].map((r: { dir: string }) => r.dir)).toContain(
      "packages/jobs"
    );
  });

  it("a file vitest's substring filter would also reach runs in its host's shard", () => {
    const a = assignApiFiles(apiFiles, plan, 4);
    expect(a.get("src/x/src/a.test.ts")).toBe(a.get("src/a.test.ts"));
    expect(a.get("src/new-file.test.ts")).toBe(
      hashShard("src/new-file.test.ts", 4)
    );
  });

  it("no plan, a plan for another count, or no file list: vitest --shard, packages in shard 1", () => {
    for (const [p, files] of [
      [null, apiFiles],
      [{ ...plan, shards: 3 }, apiFiles],
      [plan, null],
    ] as const) {
      const shards = shardsOf(p, files as string[] | null);
      const api = shards.map((s) =>
        s.find((r: { dir: string }) => r.dir === "packages/api")
      );
      expect(api.map((r: { args: string[] }) => r.args.at(-1))).toEqual([
        "--shard=1/4",
        "--shard=2/4",
        "--shard=3/4",
        "--shard=4/4",
      ]);
      expect(shards[0].map((r: { dir: string }) => r.dir)).toContain(
        "packages/database"
      );
    }
  });

  it("a plan that leaves a shard with no api file throws instead of running nothing", () => {
    const lopsided = { ...plan, api: { "src/a.test.ts": [1, 1] } };
    expect(() =>
      runsForShard(
        runs,
        { k: 2, n: 4 },
        { plan: lopsided, apiFiles: ["src/a.test.ts"] }
      )
    ).toThrow(/no packages\/api file/);
  });

  it("the committed plan fits the CI shard count and names real files", () => {
    const committed = loadShardPlan();
    expect(planFits(committed, 4)).toBe(true);
    const names = Object.keys(committed.api);
    expect(names.length).toBeGreaterThan(1500);
    const missing = names.filter(
      (f) => !existsSync(join(REPO, "packages/api", f))
    );
    // A few renames between refreshes are expected (they fall to the hash);
    // a plan whose files mostly vanished is a stale plan.
    expect(missing.length / names.length).toBeLessThan(0.1);
    for (const k of [1, 2, 3, 4])
      expect(
        Object.values(committed.api).some((v) => (v as number[])[0] === k)
      ).toBe(true);
  });
});

describe("test-ratchet shards: the PR tier's must-run files", () => {
  const discovered = [
    "packages/api/src/__tripwires__/a.test.ts",
    "packages/jobs/src/b.tripwire.test.ts",
    "scripts/c.tripwire.test.ts",
  ];
  const suiteDirs = ["packages/api", "packages/jobs", "apps/pod-admin"];
  const inScope = (p: string) => p.startsWith("apps/pod-admin/");
  const exists = (f: string) => !f.includes("gone");

  it("under --affected: EVERY tripwire, and only the --also files that can run", () => {
    const { files, also } = mustRunFiles({
      discovered,
      affected: ["apps/pod-admin"],
      also: [
        "packages/api/src/x.test.ts", // kept
        "apps/pod-admin/y.test.ts", // its package runs whole: not solo
        "packages/api/src/gone.test.ts", // deleted
        "packages/core/src/z.test.ts", // a package with no suite
      ],
      inScope,
      suiteDirs,
      exists,
    });
    expect(also).toEqual(["packages/api/src/x.test.ts"]);
    expect(files).toEqual([...discovered, "packages/api/src/x.test.ts"].sort());
  });

  it("not the PR tier: the in-scope tripwires only, as before", () => {
    expect(
      mustRunFiles({
        discovered,
        affected: null,
        also: ["packages/api/src/x.test.ts"],
        inScope: (p: string) => p.startsWith("packages/jobs/"),
        suiteDirs,
        exists,
      })
    ).toEqual({ files: ["packages/jobs/src/b.tripwire.test.ts"], also: [] });
  });

  it("shard 1 runs, per owning dir, what no package run reaches", () => {
    expect(
      soloRuns([...discovered, "packages/api/src/x.test.ts"], ["packages/jobs"])
    ).toEqual([
      {
        id: "tripwires:packages/api",
        dir: "packages/api",
        args: ["src/__tripwires__/a.test.ts", "src/x.test.ts"],
      },
      { id: "tripwires:.", dir: ".", args: ["scripts/c.tripwire.test.ts"] },
    ]);
  });
});
