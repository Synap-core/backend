/**
 * The Full suite runs as N shard jobs and one judge. A shard plan that drops a
 * package, or a merge that reads a partial run as complete, would turn the gate
 * green over tests that never ran. This pins both.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import {
  SHARDED_DIRS,
  mergeShardReports,
  parseShard,
  runsForShard,
  shardReportId,
} from "./test-ratchet-shards.mjs";

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
