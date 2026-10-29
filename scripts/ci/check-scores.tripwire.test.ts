/**
 * check-scores.mjs ranks the CI checks by p/c; preflight's order and the
 * weekly review read it. A score that counted main's reds against PRs, or a
 * hold (red on purpose) as a failure, would rank the wrong checks first. This
 * pins the formula on hand-built runs (pure functions, no network).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import { HOLD_STEP, gh, laplace, observe, score } from "./check-scores.mjs";

const at = (min: number) =>
  new Date(Date.UTC(2026, 9, 28, 10, min)).toISOString();
const job = (
  name: string,
  conclusion: string,
  steps: Array<[string, string]>,
  from = 0,
  to = 2
) => ({
  name,
  conclusion,
  started: at(from),
  completed: at(to),
  steps: steps.map(([n, c], i) => ({
    name: n,
    conclusion: c,
    started: at(from + i * 0.1),
    completed: at(from + i * 0.1 + 0.05),
  })),
});
const pr = (id: number, jobs: unknown[]) => ({
  id,
  workflow: "ci.yml",
  event: "pull_request",
  branch: `fix/${id}`,
  started: at(id),
  jobs,
});

describe("check-scores", () => {
  it("Laplace: a check never seen red still has p > 0", () => {
    expect(laplace(0, 50)).toBeCloseTo(1 / 52);
    expect(laplace(9, 50)).toBeCloseTo(10 / 52);
  });

  it("a hold is not a failure, and a cancelled job is not a run", () => {
    const { units, steps } = observe([
      pr(1, [job("API e2e", "failure", [["Preflight red (x)", "failure"]])]),
      pr(2, [job("API e2e", "cancelled", [["E2E", "failure"]])]),
      pr(3, [job("API e2e", "failure", [["E2E", "failure"]])]),
    ]);
    expect(units.map((u: { run: { id: number } }) => u.run.id)).toEqual([3]);
    expect(steps.map((s: { key: string }) => s.key)).toEqual(["API e2e › E2E"]);
    expect(HOLD_STEP.test("Suites not run (draft)")).toBe(true);
    expect(HOLD_STEP.test("Fail on a red check")).toBe(false);
  });

  it("the 4 shards and the judge are ONE Full suite unit, first start to last end", () => {
    const { units } = observe([
      pr(1, [
        job("Full suite (shard 1/4)", "success", [], 0, 20),
        job("Full suite (shard 2/4)", "failure", [["Test", "failure"]], 1, 12),
        job("Full suite", "failure", [], 21, 22),
      ]),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].key).toBe("Full suite");
    expect(units[0].failed).toBe(true);
    expect(units[0].secs).toBe(22 * 60);
  });

  it("a PR selection's shards (1 to 8) are the same unit, and shard 1's steps keep one key", () => {
    // Since lane L8 a PR selection runs "Full suite (shard 1/1)" … "(shard
    // k/8)"; preflight mirrors "Full suite (shard 1/4) › Security Audit".
    const { units, steps } = observe([
      pr(1, [
        job(
          "Full suite (shard 1/2)",
          "success",
          [["Security Audit", "success"]],
          0,
          8
        ),
        job("Full suite (shard 2/2)", "success", [], 0, 9),
        job("Full suite", "success", [], 9, 10),
      ]),
      pr(2, [
        job(
          "Full suite (shard 1/1)",
          "success",
          [["Security Audit", "success"]],
          0,
          6
        ),
        job("Full suite", "success", [], 6, 7),
      ]),
    ]);
    expect(units.map((u: { key: string }) => u.key)).toEqual([
      "Full suite",
      "Full suite",
    ]);
    expect(steps.map((s: { key: string }) => s.key)).toEqual([
      "Full suite (shard 1/4) › Security Audit",
      "Full suite (shard 1/4) › Security Audit",
    ]);
  });

  it("the Release gate's parts and judge are ONE unit, and keep the single job's step keys", () => {
    // Since 2026-10-29 the Release gate is "Release gate: <part>" jobs plus a
    // judge named "Release gate". Rows before and after the split must be one
    // row, or the preflight's `mirrors: "Release gate › Lint"` finds no p.
    const { units, steps } = observe([
      pr(1, [
        job("Release gate: lint", "failure", [["Lint", "failure"]], 0, 5),
        job(
          "Release gate: typecheck, build, boot",
          "success",
          [["Build", "success"]],
          0,
          9
        ),
        job("Release gate", "failure", [], 10, 11),
        job("Release gates and more", "success", [["Lint", "success"]], 0, 1),
      ]),
    ]);
    const gate = units.find((u: { key: string }) => u.key === "Release gate");
    expect(gate?.failed).toBe(true);
    expect(gate?.secs).toBe(11 * 60);
    expect(gate?.failedSteps).toEqual(["Release gate › Lint"]);
    expect(steps.map((s: { key: string }) => s.key)).toEqual([
      "Release gate › Lint",
      "Release gate › Build",
      // A job that merely starts with the words is not a part.
      "Release gates and more › Lint",
    ]);
  });

  it("a red main also had at the time is exonerated; the rest counts", () => {
    const obs = [0, 1, 2, 3].map((i) => ({
      run: { event: "pull_request", branch: "fix/x", id: i },
      failed: i < 3,
      secs: 60 * (i + 1),
    }));
    const s = score(obs, (o: { run: { id: number } }) => o.run.id === 0);
    expect(s).toMatchObject({ n: 4, rawFailures: 3, exonerated: 1, f: 2 });
    expect(s.p).toBeCloseTo(3 / 6, 4);
    expect(s.c_min).toBeCloseTo(2.5, 4); // median of 1,2,3,4 min
  });

  it("negctl branches and main pushes are not PR runs", () => {
    const obs = [
      {
        run: { event: "pull_request", branch: "negctl/x" },
        failed: true,
        secs: 60,
      },
      { run: { event: "push", branch: "main" }, failed: true, secs: 60 },
    ];
    expect(score(obs, () => false).n).toBe(0);
  });
});

// A job log carries ANSI codes. The runner's gh refuses to print them
// without --allow-escape-sequences (run 40937265099); an older gh (2.87.2)
// rejects the flag. Two fake `gh` executables on PATH, one of each.
describe("check-scores gh: raw job logs through a new and an old gh", () => {
  const PATH = process.env.PATH;
  let dir = "";
  afterEach(() => {
    process.env.PATH = PATH;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const fakeGh = (body: string) => {
    dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    const f = join(dir, "gh");
    writeFileSync(
      f,
      `#!/usr/bin/env node\nconst a = process.argv.slice(2);\n${body}\n`
    );
    chmodSync(f, 0o755);
    process.env.PATH = `${dir}:${PATH}`;
  };
  const LOG = "\u001b[31mred\u001b[0m";

  it("a new gh: the raw read passes --allow-escape-sequences and gets the log", async () => {
    fakeGh(
      `if (!a.includes("--allow-escape-sequences")) { console.error("the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway"); process.exit(1); }\nprocess.stdout.write(${JSON.stringify(LOG)});`
    );
    expect(await gh("repos/x/actions/jobs/1/logs", { raw: true })).toBe(LOG);
  });

  it("an old gh: the unknown flag is retried without it", async () => {
    fakeGh(
      `if (a.includes("--allow-escape-sequences")) { console.error("unknown flag: --allow-escape-sequences"); process.exit(1); }\nprocess.stdout.write(${JSON.stringify(LOG)});`
    );
    expect(await gh("repos/x/actions/jobs/1/logs", { raw: true })).toBe(LOG);
  });

  it("any other error is not swallowed; a JSON read never sends the flag", async () => {
    fakeGh(
      `if (a.includes("--allow-escape-sequences")) { console.error("HTTP 404"); process.exit(1); }\nprocess.stdout.write('{"ok":true}');`
    );
    await expect(
      gh("repos/x/actions/jobs/1/logs", { raw: true })
    ).rejects.toThrow(/404/);
    expect(await gh("repos/x/actions/runs/1")).toEqual({ ok: true });
  });
});
