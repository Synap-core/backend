/**
 * Preflight (scripts/preflight.mjs) and the CI gating built on it (ci.yml).
 *
 * Two promises are pinned here:
 *   1. preflight reports EVERY red in one run (never only the first, unless
 *      asked), and a check that decided nothing is never a PASS;
 *   2. when the "Preflight" job is red on a pull request, each of the four
 *      REQUIRED checks still runs and FAILS at a "Preflight red" step before
 *      doing any work — never a skip (a job skipped by its `if:` reports
 *      success to a required check) and never a wait on a job that cannot run.
 * The required set is DERIVED from scripts/apply-main-protection.sh (what the
 * ruleset is written from), so a new required check joins by existing.
 *
 * NOT COVERED: ci.yml is read as text (an `if:` is matched, not evaluated);
 * that GitHub really evaluates these expressions as intended is proven only by
 * a CI run (the PR that added this test: a green run, and a red preflight
 * negative control).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import { CHECKS, inScoreOrder, runChecks } from "./preflight.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

type Verdict = "PASS" | "FAIL" | "WARN" | "SKIP";
const check = (
  id: string,
  verdict: Verdict | "THROW" | "NONE",
  extra: Record<string, unknown> = {}
) => ({
  id,
  tier: 0,
  fix: `fix ${id}`,
  ...extra,
  run: async () => {
    if (verdict === "THROW") throw new Error("network down");
    if (verdict === "NONE") return { nope: true };
    return { verdict, detail: id };
  },
});

describe("preflight: every red, never a false pass", () => {
  it("runs every check and reports every red", async () => {
    const out = await runChecks(
      [
        check("a", "FAIL"),
        check("b", "PASS"),
        check("c", "FAIL"),
        check("d", "SKIP"),
      ],
      {}
    );
    expect(out.map((r: { id: string }) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(
      out
        .filter((r: { verdict: string }) => r.verdict === "FAIL")
        .map((r: { id: string }) => r.id)
    ).toEqual(["a", "c"]);
  });

  it("--first stops after the first red, in the given order", async () => {
    const out = await runChecks(
      [check("a", "PASS"), check("b", "FAIL"), check("c", "FAIL")],
      {},
      { first: true }
    );
    expect(out.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
  });

  it("a crash or a missing verdict is a WARN, never a PASS", async () => {
    const out = await runChecks([check("t", "THROW"), check("n", "NONE")], {});
    expect(out.map((r: { verdict: string }) => r.verdict)).toEqual([
      "WARN",
      "WARN",
    ]);
  });

  it("an informational or advisory check can warn, never fail the run", async () => {
    const out = await runChecks(
      [
        check("i", "FAIL", { informational: true }),
        check("v", "FAIL", { advisory: true }),
      ],
      {}
    );
    expect(out.map((r: { verdict: string }) => r.verdict)).toEqual([
      "WARN",
      "WARN",
    ]);
  });

  it("orders by measured score, then by declaration", () => {
    const scores = {
      checks: [
        { check: "low", p: 0.01 },
        { check: "high", p: 0.5 },
      ],
      preflightCosts: {},
    };
    const ordered = inScoreOrder(
      [
        { id: "x", mirrors: "low", costHint: 1 },
        { id: "y", mirrors: null, costHint: 1 },
        { id: "z", mirrors: "high", costHint: 1 },
      ],
      scores
    );
    expect(ordered.map((c: { id: string }) => c.id)).toEqual(["z", "x", "y"]);
  });

  it("covers the reds of 2026-10-28 in its no-build tier", () => {
    const tier0 = CHECKS.filter((c: { tier: number }) => c.tier === 0).map(
      (c: { id: string }) => c.id
    );
    for (const id of ["api-types-freshness", "door-tool-names", "main-status"])
      expect(tier0).toContain(id);
  });
});

// door-tool-names, end to end through the CLI and its CI contract: the SAME
// builder and committed table as door-tool-names.freshness.test.ts, against a
// CP catalog given as a file. No network.
describe("preflight --ci: door-tool-names against a CP catalog file", () => {
  const generated = readFileSync(
    join(REPO, "packages/api/src/routers/mcp/door-tool-names.generated.ts"),
    "utf8"
  );
  // The CP catalog that produces exactly the committed table.
  const pairs = [
    ...generated.matchAll(
      /"pod-mcp":\s*"(synap_[a-z_]+)",\s*"cp-connector":\s*"pod__([a-z_]+)"/g
    ),
  ].map((m) => `  { name: "${m[2]}", podToolName: "${m[1]}" },`);
  const cli = (catalog: string) => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    const cp = join(dir, "mcp-pod-tools.ts");
    const out = join(dir, "github-output");
    writeFileSync(cp, `export const CURATED = [\n${catalog}\n];\n`);
    writeFileSync(out, "");
    const env = { ...process.env, GITHUB_OUTPUT: out, PR_BODY: "" };
    delete env.GITHUB_STEP_SUMMARY;
    const r = spawnSync(
      "node",
      [
        "scripts/preflight.mjs",
        "--ci",
        "--only=door-tool-names",
        `--cp-source=${cp}`,
      ],
      { cwd: REPO, encoding: "utf8", env }
    );
    return {
      code: r.status,
      out: `${r.stdout}${r.stderr}`,
      outputs: readFileSync(out, "utf8").split("\n"),
    };
  };

  it("the probe catalog is not vacuous", () => {
    expect(pairs.length).toBeGreaterThan(30);
  });

  it("a fresh table: red=false", () => {
    const r = cli(pairs.join("\n"));
    expect(r.out).toContain("PASS");
    expect(r.outputs).toContain("red=false");
    expect(r.code).toBe(0);
  });

  it("a CP change the table missed: red=true, named, and the CI step still exits 0", () => {
    const r = cli(pairs.slice(1).join("\n"));
    expect(r.out).toContain("FAIL");
    expect(r.out).toContain("::error title=Preflight door-tool-names::");
    expect(r.outputs).toContain("red=true");
    expect(r.outputs).toContain("reds=door-tool-names");
    expect(r.code).toBe(0);
  });
});

// ci.yml as text: one block per job, at two-space indent.
const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
const jobs = ci
  .slice(ci.indexOf("\njobs:\n"))
  .split(/\n(?= {2}[A-Za-z0-9_-]+:\s*\n)/)
  .slice(1)
  .map((block) => ({
    key: /^ {2}([A-Za-z0-9_-]+):/m.exec(block)?.[1] ?? "",
    name: /^ {4}name: (.+)$/m.exec(block)?.[1] ?? "",
    needs: /^ {4}needs: (.+)$/m.exec(block)?.[1] ?? "",
    if: /^ {4}if: (.+)$/m.exec(block)?.[1] ?? "",
    services: /^ {4}services:/m.test(block),
    images: [...block.matchAll(/^ {8}image: (.+)$/gm)].map((m) => m[1]),
    steps: (block.split(/^ {4}steps:\n/m)[1] ?? "").split(/^ {6}- /m).slice(1),
    block,
  }));
const REQUIRED = (() => {
  const sh = readFileSync(
    join(REPO, "scripts/apply-main-protection.sh"),
    "utf8"
  );
  const m = /^REQUIRED_CHECKS=\((.+)\)$/m.exec(sh);
  return [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();
const HOLD = "needs.preflight.outputs.hold == 'true'";
const NOT_HOLD = "needs.preflight.outputs.hold != 'true'";

describe("ci.yml: a red preflight fails every required check, skips none", () => {
  const preflight = jobs.find((j) => j.key === "preflight");

  it("the scans are not vacuous", () => {
    expect(jobs.length).toBeGreaterThan(6);
    expect(REQUIRED).toEqual(
      expect.arrayContaining(["Release gate", "Full suite", "API e2e"])
    );
    expect(REQUIRED.length).toBeGreaterThanOrEqual(4);
  });

  it("the Preflight job runs the script and holds only off a push", () => {
    expect(preflight?.name).toBe("Preflight");
    expect(preflight?.needs).toBe("");
    expect(preflight?.if).toBe("");
    expect(preflight?.block).toContain(
      "node scripts/preflight.mjs --ci --tier=0"
    );
    expect(preflight?.block).toMatch(
      /hold: \$\{\{ steps\.run\.outputs\.red == 'true' && github\.event_name != 'push' && 'true' \|\| 'false' \}\}/
    );
  });

  it("every required check is a job of ci.yml (one workflow, so it can wait)", () => {
    for (const name of REQUIRED)
      expect(
        jobs.filter((j) => j.name === name),
        name
      ).toHaveLength(1);
  });

  it("each required check waits for Preflight, runs on a hold, and fails before any work", () => {
    for (const name of REQUIRED) {
      const j = jobs.find((x) => x.name === name)!;
      expect(j.needs, name).toMatch(/\bpreflight\b/);
      // runs on a hold: either the hold is in its `if:`, or nothing but
      // cancellation can skip it
      expect(
        j.if.includes(HOLD) || j.if === "${{ !cancelled() }}",
        `${name} if: ${j.if}`
      ).toBe(true);
      expect(j.if, name).not.toContain(NOT_HOLD);
      const at = j.steps.findIndex(
        (s) =>
          s.startsWith("name: Preflight red") &&
          s.includes(`if: \${{ ${HOLD} }}`)
      );
      expect(at, `${name} has a Preflight red step`).toBeGreaterThanOrEqual(0);
      expect(j.steps[at], name).toMatch(/\n\s+exit 1\n/);
      // nothing before it but other hold steps (no checkout, no install)
      for (const s of j.steps.slice(0, at))
        expect(s, `${name}: work before the hold`).toMatch(/\n\s+exit 1\n/);
      // a hold starts no service container
      for (const image of j.images)
        expect(image, `${name} service`).toContain(NOT_HOLD);
    }
  });

  it("every other job that waits for Preflight skips its work on a hold", () => {
    const others = jobs.filter(
      (j) => /\bpreflight\b/.test(j.needs) && !REQUIRED.includes(j.name)
    );
    expect(others.map((j) => j.key)).toContain("full-suite-shard");
    for (const j of others) expect(j.if, j.key).toContain(NOT_HOLD);
  });

  it("the Full suite judge does not also blame the shards on a hold", () => {
    const judge = jobs.find((j) => j.name === "Full suite")!;
    const every = judge.steps.find((s) =>
      s.startsWith("name: Every shard job succeeded")
    );
    expect(every).toContain(NOT_HOLD);
  });
});
