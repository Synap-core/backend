/**
 * TRIPWIRE — `automations.run_count` has ONE writer: the executor, which counts
 * a run once, when it ends (ticket 85133a81).
 *
 * The dispatchers (the cron scheduler and the event trigger matcher) also added
 * 1 when they enqueued the run, so every automation read twice its runs (live:
 * 142 runs for 70 outcomes).
 *
 * Scans every non-test source file of the jobs and api packages (derived, not
 * hand-listed) for an increment of `runCount` and expects exactly the executor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" || name === "dist" ? [] : sources(path);
    }
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const INCREMENT =
  /runCount:\s*drizzleSql`[^`]*automations\.runCount[^`]*\+\s*1/;

describe("automation runCount — one writer (85133a81)", () => {
  const writers = ["jobs/src", "api/src"]
    .flatMap((d) => sources(join(PACKAGES, d)))
    .filter((f) => INCREMENT.test(stripComments(readFileSync(f, "utf8"), "ts")))
    .map((f) => relative(PACKAGES, f));

  it("only the executor increments it", () => {
    expect(
      writers,
      "A second runCount writer doubles every automation's runs. Count a run once, in automation-executor.ts, when it ends."
    ).toEqual(["jobs/src/workers/automation-executor.ts"]);
  });
});
