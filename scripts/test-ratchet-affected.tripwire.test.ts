/**
 * The PR tier through the REAL judge: `test-ratchet.mjs --reports=DIR
 * --shards=4` with the scope CI hands it (TEST_RATCHET_SCOPE / _AFFECTED /
 * _ALSO), reading exactly the reports the shards write in that scope. The
 * reports are written here from the shards' own planning functions
 * (mustRunFiles, soloRuns: what shard 1 runs and under which report id), so
 * a judge that expects a report under another id, or misses a tripwire, goes
 * red here before it goes red on every leaf PR. Each file's verdict follows
 * the baseline (a known-red file is reported red), so the judge's own
 * "fixed" and "stale" checks pass only when every file is where it expects.
 *
 * What it does not cover: that vitest really runs those files (the shards do
 * that on CI); the merge queue's and main's full scope (no TEST_RATCHET_SCOPE).
 * It proves the judge and the shards AGREE, not that the rule is right: with
 * mustRunFiles narrowed to the in-scope tripwires both sides narrow and this
 * stays green (measured); test-ratchet-shards.tripwire.test.ts pins the rule.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import { mustRunFiles, ownerDir, soloRuns } from "./test-ratchet-shards.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { discoverTripwires } from "./tripwire-discovery.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { workspacePackages } from "./ci/affected.mjs";

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
// The packages with a `vitest run` test script (the ratchet's package runs).
const suiteDirs: string[] = workspacePackages(REPO)
  .map((p: { dir: string }) => p.dir)
  .filter((d: string) =>
    /^vitest run/.test(
      JSON.parse(readFileSync(join(REPO, d, "package.json"), "utf8")).scripts
        ?.test ?? ""
    )
  );

// A vitest JSON report of these repo-relative files, each red when the
// baseline says it is red today.
const report = (files: string[]) => ({
  numTotalTests: files.length + 1000,
  numPassedTests: 1000,
  testResults: files.map((f) => ({
    name: join(REPO, f),
    status: baseline.has(f) ? "failed" : "passed",
    message: baseline.has(f) ? "known red" : "",
    assertionResults: [{ status: baseline.has(f) ? "failed" : "passed" }],
  })),
});
const fileName = (id: string) => `${id.replace(/[^a-z0-9]+/gi, "_")}.json`;

/** Write what the 4 shards write for this scope, then run the judge. */
function judge(
  affected: string[],
  also: string[],
  { drop }: { drop?: string } = {}
) {
  const inScope = (p: string) =>
    affected.some((d) => p === d || p.startsWith(`${d}/`));
  const { files: mustRun } = mustRunFiles({
    discovered: tripwires,
    affected,
    also,
    inScope,
    suiteDirs,
    exists: (f: string) => existsSync(join(REPO, f)),
  });
  const runDirs = suiteDirs.filter(inScope);
  const reports: Record<string, string[]> = {};
  // Each package run's report holds its own files that must run (its
  // tripwires) and its known-red files (in vitest's run they would be there).
  for (const d of runDirs)
    reports[d] = [
      ...mustRun.filter((f: string) => ownerDir(f) === d),
      ...[...baseline].filter((f) => f.startsWith(`${d}/`)),
    ];
  // packages/api is sharded: its run reports per shard (all in shard 1 here).
  if (reports["packages/api"]) {
    for (const k of [1, 2, 3, 4])
      reports[`packages/api#shard${k}`] =
        k === 1 ? reports["packages/api"] : [];
    delete reports["packages/api"];
  }
  for (const r of soloRuns(mustRun, runDirs))
    reports[r.id] = r.args.map((a: string) =>
      r.dir === "." ? a : `${r.dir}/${a}`
    );
  const dir = mkdtempSync(join(tmpdir(), "ratchet-affected-"));
  try {
    for (const [id, files] of Object.entries(reports))
      if (id !== drop)
        writeFileSync(join(dir, fileName(id)), JSON.stringify(report(files)));
    const r = spawnSync(
      process.execPath,
      [SCRIPT, `--reports=${dir}`, "--shards=4"],
      {
        cwd: REPO,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: "",
          GITHUB_STEP_SUMMARY: "",
          TEST_RATCHET_SCOPE: "affected",
          TEST_RATCHET_AFFECTED: affected.join(","),
          TEST_RATCHET_ALSO: also.join(","),
        },
      }
    );
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      ids: Object.keys(reports),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("test-ratchet: the PR tier, judged as CI judges it", () => {
  it("the scan is not vacuous", () => {
    expect(tripwires.length).toBeGreaterThan(300);
    expect(suiteDirs).toContain("packages/api");
    expect(suiteDirs).toContain("apps/pod-admin");
  });

  it("a leaf package: its suite, every tripwire (packages/api's in shard 1), an --also file", () => {
    const also = [
      "packages/api/src/services/capabilities/install-layers.test.ts",
    ];
    const r = judge(["apps/pod-admin"], also);
    expect(r.ids).toContain("tripwires:packages/api");
    expect(r.out).toContain("test ratchet OK");
    expect(r.status).toBe(0);
  });

  it("no package at all (only the generated API reference changed): every tripwire, nothing else", () => {
    const r = judge([], []);
    expect(r.out).toContain("test ratchet OK");
    expect(r.status).toBe(0);
  });

  it("packages/api affected: its shard reports, and the rest of the tripwires", () => {
    const r = judge(["packages/api", "apps/api"], []);
    expect(r.ids).toContain("packages/api#shard1");
    expect(r.out).toContain("test ratchet OK");
    expect(r.status).toBe(0);
  });

  it("a tripwire report shard 1 did not write: red, never a partial green", () => {
    const r = judge(["apps/pod-admin"], [], { drop: "tripwires:packages/api" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/no-report|tripwire-unrun/);
  });
});
