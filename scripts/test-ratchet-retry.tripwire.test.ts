/**
 * The flake retry (scripts/test-ratchet-retry.mjs): a NEW failure is re-run
 * once in the same job; a pass on the retry is `[flaky]`, listed and not
 * counted; a second failure, or no retry report, stays red. A retry rule that
 * turned a real red green would let a broken change merge, so this pins the
 * rule AND the judge's wiring of it (the real test-ratchet.mjs, judging a
 * fixture reports directory).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import {
  MAX_RETRY_FILES,
  applyRetry,
  newFailures,
  retryArgs,
  retryReportId,
} from "./test-ratchet-retry.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const red = (reason = "boom") => ({ ok: false, reason });
const green = { ok: true, reason: "" };

describe("test-ratchet retry: the rule", () => {
  const baseline = new Map([["known-red.test.ts", {}]]);
  const first = new Map<string, { ok: boolean; reason: string }>([
    ["flaky.test.ts", red("timeout")],
    ["broken.test.ts", red("assert")],
    ["unretried.test.ts", red("crash")],
    ["known-red.test.ts", red("known")],
    ["fine.test.ts", green],
  ]);

  it("only failures outside the baseline are retried", () => {
    expect(newFailures(first, baseline).sort()).toEqual([
      "broken.test.ts",
      "flaky.test.ts",
      "unretried.test.ts",
    ]);
  });

  it("a pass on the retry is flaky; a second failure or a missing file stays red", () => {
    const retry = new Map([
      ["flaky.test.ts", green],
      ["broken.test.ts", red("assert again")],
      // unretried.test.ts: absent from the retry report
      ["known-red.test.ts", green], // a baseline file is never made flaky
    ]);
    const { files, flaky } = applyRetry(first, retry, baseline);
    expect(flaky).toEqual([{ file: "flaky.test.ts", firstReason: "timeout" }]);
    expect(files.get("flaky.test.ts")?.ok).toBe(true);
    expect(files.get("broken.test.ts")?.ok).toBe(false);
    expect(files.get("unretried.test.ts")?.ok).toBe(false);
    expect(files.get("known-red.test.ts")?.ok).toBe(false);
    // pure: the first run's map is untouched
    expect(first.get("flaky.test.ts")?.ok).toBe(false);
  });

  it("no retry report: every red stays red", () => {
    const { files, flaky } = applyRetry(first, null, baseline);
    expect(flaky).toEqual([]);
    expect([...files.values()].filter((v) => !v.ok)).toHaveLength(4);
  });

  it("the retry keeps the package's flags and drops its filters and --shard", () => {
    expect(
      retryArgs(
        ["--passWithNoTests", "src/a.test.ts", "--shard=2/4", "src/b.test.ts"],
        ["src/x.test.ts"]
      )
    ).toEqual(["--passWithNoTests", "src/x.test.ts"]);
    expect(retryReportId("packages/api#shard2")).toBe(
      "packages/api#shard2#retry"
    );
    expect(MAX_RETRY_FILES).toBeGreaterThan(0);
  });
});

// The judge, end to end: test-ratchet.mjs --reports=DIR on one real package
// (packages/field-crypto: no baseline entry, no floor, no tripwire).
describe("test-ratchet retry: the judge reads the retry report", () => {
  const PKG = "packages/field-crypto";
  const FILE = join(REPO, PKG, "src/index.test.ts");
  const OTHER = join(REPO, PKG, "src/other.test.ts");
  const report = (status: "passed" | "failed") => ({
    numTotalTests: 3,
    numPassedTests: status === "passed" ? 3 : 2,
    testResults: [
      {
        name: FILE,
        status,
        message: status === "failed" ? "flaked: socket hang up" : "",
        assertionResults: [{ status }],
      },
      {
        name: OTHER,
        status: "passed",
        assertionResults: [{ status: "passed" }, { status: "passed" }],
      },
    ],
  });
  const judge = (retry: "passed" | "failed" | null) => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
    writeFileSync(
      join(dir, "packages_field_crypto.json"),
      JSON.stringify(report("failed"))
    );
    if (retry)
      writeFileSync(
        join(dir, "packages_field_crypto_retry.json"),
        JSON.stringify({
          ...report(retry),
          testResults: report(retry).testResults.slice(0, 1),
        })
      );
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    delete env.GITHUB_ACTIONS;
    // The Full suite job sets the affected tier's scope (#501); inherited, it
    // makes the judge look for packages this fixture never reported.
    for (const k of Object.keys(env))
      if (k.startsWith("TEST_RATCHET_")) delete env[k];
    const r = spawnSync(
      "node",
      ["scripts/test-ratchet.mjs", `--reports=${dir}`, `--only=${PKG}`],
      { cwd: REPO, encoding: "utf8", env }
    );
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("failed, then passed on the retry: green, listed as [flaky]", () => {
    const r = judge("passed");
    expect(r.out).toContain("[flaky]");
    expect(r.out).toContain(`${PKG}/src/index.test.ts`);
    expect(r.out).not.toContain("[new-failure]");
    expect(r.code, r.out).toBe(0);
  });

  it("failed twice: red, a new failure", () => {
    const r = judge("failed");
    expect(r.out).toContain("[new-failure]");
    expect(r.code).not.toBe(0);
  });

  it("no retry report: red, a new failure", () => {
    const r = judge(null);
    expect(r.out).toContain("[new-failure]");
    expect(r.code).not.toBe(0);
  });
});
