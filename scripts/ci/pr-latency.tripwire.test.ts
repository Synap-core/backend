/**
 * pr-latency.mjs measures the founder's target (a PR's 4 required checks
 * green in 8-10 min). A run counts only when all 4 concluded `success`; a
 * skipped, red or missing one is not a time to green. Pinned on hand-built
 * job lists (GitHub's jobs API shape); the gh calls are not exercised here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED,
  jobKind,
  measure,
  quantile,
  scopeOf,
  shardCount,
  // @ts-expect-error — plain ESM script, no declarations
} from "./pr-latency.mjs";

const T0 = "2026-10-29T10:00:00Z";
const at = (min: number) =>
  new Date(Date.parse(T0) + min * 60000).toISOString();
const job = (
  name: string,
  start: number,
  end: number,
  conclusion = "success"
) => ({
  name,
  conclusion,
  started_at: at(start),
  completed_at: at(end),
});
const green = () => [
  job("What changed", 0.1, 0.3),
  job("Full suite (shard 1/2)", 1, 8),
  job("Full suite (shard 2/2)", 1, 9.5),
  job("Release gate", 6, 6.2),
  job("Full suite", 9.6, 9.8),
  job("API e2e", 1, 5),
  job("Reference docs are current", 1, 2.5),
];

describe("pr-latency: what a time to green is", () => {
  it("the push to the last required check, with the job that held it", () => {
    const m = measure({ created_at: T0 }, green());
    expect(m.green).toBeCloseTo(9.8, 5);
    // The judge finished 0.3 min after its last shard: the shard is the cause.
    expect(m.last).toBe("Full suite (shard k/2)");
    expect(
      m.jobs.find((j: { name: string }) => j.name === "API e2e").took
    ).toBeCloseTo(4, 5);
  });

  it("a red, skipped or missing required check is no time to green", () => {
    for (const name of REQUIRED) {
      const red = green().map((j) =>
        j.name === name ? { ...j, conclusion: "failure" } : j
      );
      expect(measure({ created_at: T0 }, red), `${name} red`).toBeNull();
      const skipped = green().map((j) =>
        j.name === name ? { ...j, conclusion: "skipped" } : j
      );
      expect(
        measure({ created_at: T0 }, skipped),
        `${name} skipped`
      ).toBeNull();
      const gone = green().filter((j) => j.name !== name);
      expect(measure({ created_at: T0 }, gone), `${name} missing`).toBeNull();
    }
  });

  it("reads the tier from the decision's log line and the shard count from the job names", () => {
    expect(scopeOf("2026-10-29T10:00:01.1Z scope=selected\n")).toBe("selected");
    expect(scopeOf("x\nscope=full\n")).toBe("full");
    expect(scopeOf("no decision here")).toBe("unknown");
    expect(shardCount(green())).toBe(2);
    expect(shardCount([job("Release gate", 0, 1)])).toBe(0);
    expect(jobKind("Full suite (shard 3/8)")).toBe("Full suite (shard k/8)");
  });

  it("quantiles: nearest rank, nulls ignored", () => {
    expect(quantile([5, 1, 3, null], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("REQUIRED is the ruleset's list (scripts/apply-main-protection.sh)", () => {
    const sh = readFileSync(
      join(
        fileURLToPath(new URL("../..", import.meta.url)),
        "scripts/apply-main-protection.sh"
      ),
      "utf8"
    );
    for (const name of REQUIRED) expect(sh).toContain(`"${name}"`);
  });
});
