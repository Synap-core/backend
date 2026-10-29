/**
 * The "Release gate" check is ONE job judging parallel "Release gate: <part>"
 * jobs (ci.yml, 2026-10-29). Its name and its verdict are what releases
 * (docker-publish.yml ci-gate) and the merge queue read. A judge that passes
 * on a skipped or cancelled sub-job, or a sub-job the judge does not wait
 * for, releases a commit nobody built. This pins the verdict for every
 * result GitHub reports, the wiring in ci.yml (derived from the job names,
 * not a hand list), and that every step of the old single job still runs.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import { judge } from "./release-gate-judge.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "scripts/ci/release-gate-judge.mjs");

const needs = (r: Record<string, string>) =>
  Object.fromEntries(
    Object.entries({
      changes: "success",
      preflight: "success",
      ...r,
    }).map(([id, result]) => [id, { result, outputs: {} }])
  );
const green = {
  "gate-lint": "success",
  "gate-build": "success",
  "gate-deploy": "success",
  "gate-image": "success",
};
const noImage = { ...green, "gate-deploy": "skipped", "gate-image": "skipped" };

describe("release-gate-judge: the verdict", () => {
  it.each([
    // A change that does not need the image: its jobs succeed through their
    // "Not affected" step, so the judge sees `success` (ci.yml).
    ["every sub-job green", green, true],
    // Each red row rules out a looser rule ("not failure", "success or skipped").
    // Until 2026-10-29 the judge passed a skipped image job when the image was
    // not due: a skip read as a pass (decision ffaafe15).
    ["image jobs skipped", noImage, false],
    ["deploy tests skipped", { ...green, "gate-deploy": "skipped" }, false],
    ["lint failed", { ...green, "gate-lint": "failure" }, false],
    [
      "build cancelled (a timeout)",
      { ...green, "gate-build": "cancelled" },
      false,
    ],
    ["build skipped", { ...green, "gate-build": "skipped" }, false],
    ["deploy failed", { ...green, "gate-deploy": "failure" }, false],
    ["a sub-job with no result", { ...green, "gate-lint": "" }, false],
  ])("%s", (_label, results, ok) => {
    expect(judge({ needs: needs(results) }).ok).toBe(ok);
  });

  it("the deciders' results are not the gate's: a crashed preflight holds nothing", () => {
    expect(
      judge({
        needs: needs({ ...green, preflight: "failure", changes: "failure" }),
      }).ok
    ).toBe(true);
  });

  it("never a vacuous pass: no sub-job, or one sub-job", () => {
    expect(judge({ needs: needs({}) }).ok).toBe(false);
    expect(judge({ needs: needs({ "gate-build": "success" }) }).ok).toBe(false);
  });

  it("the script reads the needs context and exits 1 on red, 0 on green (the seam ci.yml runs)", () => {
    const run = (
      r: Record<string, string>,
      extra: Record<string, string> = {}
    ) =>
      spawnSync("node", [SCRIPT], {
        env: { ...process.env, NEEDS: JSON.stringify(needs(r)), ...extra },
        encoding: "utf8",
      });
    expect(run(green).status).toBe(0);
    // The retired IMAGE_DUE no longer excuses a skip, whatever it says.
    const red = run(noImage, {
      IMAGE_JOBS: "gate-deploy gate-image",
      IMAGE_DUE: "false",
    });
    expect(red.status).toBe(1);
    expect(red.stdout).toContain("RED  gate-image: skipped");
    expect(
      spawnSync("node", [SCRIPT], { env: { ...process.env, NEEDS: "" } }).status
    ).toBe(1);
  });
});

describe("release-gate-judge: ci.yml wiring", () => {
  // ci.yml read as text: the jobs block, split per job at two-space indent.
  const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
  const jobs = ci
    .slice(ci.indexOf("\njobs:\n"))
    .split(/\n(?= {2}[A-Za-z0-9_-]+:\s*\n)/)
    .slice(1)
    .map((block) => ({
      id: /^ {2}([A-Za-z0-9_-]+):/.exec(block)?.[1] ?? "",
      name: (/^ {4}name: (.+)$/m.exec(block)?.[1] ?? "").replace(
        /^"(.*)"$/,
        "$1"
      ),
      if: /^ {4}if: (.+)$/m.exec(block)?.[1] ?? "",
      needs: (/^ {4}needs: \[(.*)\]$/m.exec(block)?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      steps: (block.split(/^ {4}steps:\n/m)[1] ?? "")
        .split(/^ {6}- /m)
        .slice(1)
        .map((s) => /^(?:name: )?(.+)$/m.exec(s)?.[1] ?? ""),
      block,
    }));
  const judgeJob = jobs.find((j) => j.name === "Release gate");
  const parts = jobs.filter((j) => j.name.startsWith("Release gate: "));

  it("finds the judge and its parts (non-vacuity)", () => {
    expect(jobs.length).toBeGreaterThan(8);
    expect(judgeJob, "a job named exactly 'Release gate'").toBeDefined();
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // Self-check: the parser still reads a literal sample.
    expect(parts.map((p) => p.id)).toContain("gate-build");
  });

  it("the judge needs every part, and nothing else but the deciders", () => {
    expect([...(judgeJob?.needs ?? [])].sort()).toEqual(
      ["changes", "preflight", ...parts.map((p) => p.id)].sort()
    );
    expect(judgeJob?.block).toContain("NEEDS: ${{ toJSON(needs) }}");
    expect(judgeJob?.block).toContain(
      "run: node scripts/ci/release-gate-judge.mjs"
    );
  });

  // DERIVED: the parts whose work depends on the image decision.
  const imageParts = parts.filter((p) =>
    p.block.includes("needs.changes.outputs.image")
  );

  it("no part is skipped by the image decision: it runs and says `Not affected` (#441)", () => {
    expect(imageParts.map((p) => p.id).sort()).toEqual([
      "gate-deploy",
      "gate-image",
    ]);
    for (const p of parts)
      expect(p.if, p.id).not.toContain("needs.changes.outputs.image");
    expect(judgeJob?.block).not.toMatch(/IMAGE_(JOBS|DUE)/);
    for (const p of imageParts) {
      expect(p.block, p.id).toContain(
        "RUN_WORK: ${{ needs.changes.result != 'success' || needs.changes.outputs.image != 'false' }}"
      );
      const steps = (p.block.split(/^ {4}steps:\n/m)[1] ?? "")
        .split(/^ {6}- /m)
        .slice(1);
      // The first step is the logged pass, reached only by an explicit
      // image=false from a successful `changes`.
      expect(steps[0], p.id).toMatch(/^name: Not affected/);
      expect(steps[0]).toContain(
        "needs.changes.result == 'success' && needs.changes.outputs.image == 'false'"
      );
      expect(steps[0]).toContain("GITHUB_STEP_SUMMARY");
      expect(steps[0]).not.toMatch(/exit [1-9]/);
      // Every step after it does the work, and is gated on RUN_WORK.
      expect(steps.length, p.id).toBeGreaterThan(1);
      for (const s of steps.slice(1))
        expect(s, `${p.id}: ${s.split("\n")[0]}`).toMatch(
          /\n\s+if: \$\{\{ env\.RUN_WORK == 'true' \}\}\n/
        );
    }
  });

  it("every part runs when `changes` failed and stops for a preflight hold (fail-safe)", () => {
    for (const p of parts) {
      expect(p.if, p.id).toContain("!cancelled()");
      expect(p.if, p.id).toContain("needs.changes.result != 'success'");
      expect(p.if, p.id).toContain("needs.preflight.outputs.hold != 'true'");
      expect(p.needs, p.id).toEqual(
        expect.arrayContaining(["changes", "preflight"])
      );
    }
  });

  it("every step of the single Release gate job (before 2026-10-29) runs in exactly one part", () => {
    const OLD_STEPS = [
      "CI/CD conformance gate",
      "Lint",
      "Format Check",
      "Deploy safety tests",
      "Check orphaned REST route files",
      "Typecheck",
      "Verify generated API types are up to date",
      "Validate migrations",
      "Schema coherence check",
      "Build",
      "Start API server for smoke tests",
      "Smoke test",
      "Health serves the derived schema hash",
      "Test Docker Build",
    ];
    for (const step of OLD_STEPS) {
      const owners = parts
        .filter((p) => p.steps.includes(step))
        .map((p) => p.id);
      expect(owners, step).toHaveLength(1);
    }
    // The judge keeps the two holds as its first steps (a hold reports red).
    expect(judgeJob?.steps.slice(0, 2)).toEqual([
      "Never merges (negctl)",
      "Preflight red (${{ needs.preflight.outputs.reds }})",
    ]);
  });
});
