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
const IMAGE_JOBS = ["gate-deploy", "gate-image"];

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
    ["every sub-job green, image due", green, true, true],
    ["image jobs skipped, image not due", noImage, false, true],
    ["image jobs green although not due", green, false, true],
    // Each red row rules out a looser rule ("not failure", "success or skipped").
    ["lint failed", { ...green, "gate-lint": "failure" }, true, false],
    [
      "build cancelled (a timeout)",
      { ...green, "gate-build": "cancelled" },
      true,
      false,
    ],
    [
      "build skipped (always due)",
      { ...noImage, "gate-build": "skipped" },
      false,
      false,
    ],
    [
      "image skipped while due",
      { ...green, "gate-image": "skipped" },
      true,
      false,
    ],
    [
      "deploy failed while not due",
      { ...noImage, "gate-deploy": "failure" },
      false,
      false,
    ],
    ["a sub-job with no result", { ...green, "gate-lint": "" }, true, false],
  ])("%s", (_label, results, imageDue, ok) => {
    expect(
      judge({ needs: needs(results), imageJobs: IMAGE_JOBS, imageDue }).ok
    ).toBe(ok);
  });

  it("the deciders' results are not the gate's: a crashed preflight holds nothing", () => {
    expect(
      judge({
        needs: needs({ ...green, preflight: "failure", changes: "failure" }),
        imageJobs: IMAGE_JOBS,
        imageDue: true,
      }).ok
    ).toBe(true);
  });

  it("never a vacuous pass: no sub-job, one sub-job, or an IMAGE_JOBS name not in needs", () => {
    expect(judge({ needs: needs({}), imageJobs: [], imageDue: false }).ok).toBe(
      false
    );
    expect(
      judge({
        needs: needs({ "gate-build": "success" }),
        imageJobs: [],
        imageDue: false,
      }).ok
    ).toBe(false);
    expect(
      judge({
        needs: needs({ "gate-lint": "success", "gate-build": "success" }),
        imageJobs: ["gate-image"],
        imageDue: false,
      }).ok
    ).toBe(false);
  });

  it("the script reads the needs context and exits 1 on red, 0 on green (the seam ci.yml runs)", () => {
    const run = (r: Record<string, string>, due: string) =>
      spawnSync("node", [SCRIPT], {
        env: {
          ...process.env,
          NEEDS: JSON.stringify(needs(r)),
          IMAGE_JOBS: IMAGE_JOBS.join(" "),
          IMAGE_DUE: due,
        },
        encoding: "utf8",
      });
    expect(run(green, "true").status).toBe(0);
    expect(run(noImage, "false").status).toBe(0);
    const red = run({ ...green, "gate-image": "skipped" }, "true");
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

  it("IMAGE_JOBS is exactly the parts that run only for an image-relevant change", () => {
    const imageParts = parts
      .filter((p) => p.if.includes("needs.changes.outputs.image == 'true'"))
      .map((p) => p.id)
      .sort();
    expect(imageParts.length).toBeGreaterThan(0);
    const declared =
      /IMAGE_JOBS: (.+)$/m.exec(judgeJob?.block ?? "")?.[1] ?? "";
    expect(declared.split(/\s+/).filter(Boolean).sort()).toEqual(imageParts);
    // IMAGE_DUE reads the same condition the parts' `if:` reads.
    expect(judgeJob?.block).toContain(
      "IMAGE_DUE: ${{ needs.changes.result != 'success' || needs.changes.outputs.image == 'true' }}"
    );
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
