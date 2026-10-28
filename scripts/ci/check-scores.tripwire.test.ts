/**
 * check-scores.mjs ranks the CI checks by p/c; preflight's order and the
 * weekly review read it. A score that counted main's reds against PRs, or a
 * hold (red on purpose) as a failure, would rank the wrong checks first. This
 * pins the formula on hand-built runs (pure functions, no network).
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import { HOLD_STEP, laplace, observe, score } from "./check-scores.mjs";

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
