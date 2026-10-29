/**
 * cancel-closed-pr-runs.mjs cancels a closed PR's CI runs. Cancelling the
 * wrong run is far worse than missing one: a cancelled main push run leaves
 * main unmeasured, a cancelled merge-queue run drops a PR from the queue, and
 * a cancelled "Pod observations" run loses the `dev.pr_merged` this very
 * close fires. Each row below is a run it must leave alone, built from the
 * fields the Actions API returns (after a merge, `pull_requests` is EMPTY:
 * checked on run 40786725416 of #479). Named `*.tripwire.test.ts` so
 * `pnpm tripwires` (CI) runs it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import { selectRunsToCancel } from "./cancel-closed-pr-runs.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const pr = {
  number: 480,
  headRef: "ci/parallel-release-gate",
  headSha: "a".repeat(40),
  headRepo: "Synap-core/backend",
};
const run = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  status: "in_progress",
  head_branch: pr.headRef,
  head_sha: pr.headSha,
  head_repository: { full_name: "Synap-core/backend" },
  pull_requests: [],
  html_url: "https://github.com/Synap-core/backend/actions/runs/1",
  ...over,
});
const ids = (runs: unknown[], selfRunId?: number) =>
  selectRunsToCancel({ pr, runs, selfRunId }).map((r: { id: number }) => r.id);

describe("cancel-closed-pr-runs: which runs a closed PR cancels", () => {
  it("its own CI runs, queued or running, of its head commit or naming it", () => {
    expect(
      ids([
        run({ id: 1 }),
        run({ id: 2, status: "queued" }),
        run({ id: 3, status: "waiting" }),
        // An older commit of the branch, while the PR was open: it names the PR.
        run({
          id: 4,
          head_sha: "b".repeat(40),
          pull_requests: [{ number: 480 }],
        }),
      ])
    ).toEqual([1, 2, 3, 4]);
  });

  it.each([
    ["a push run on main", { event: "push", head_branch: "main" }],
    [
      "a merge-queue run",
      {
        event: "merge_group",
        head_branch: "gh-readonly-queue/main/pr-480-abc",
      },
    ],
    // Same branch, same commit, only the event differs: these two rows are
    // what make the event rule load-bearing (the rows above also differ by
    // branch, so they stay green without it: seen in the negative control).
    ["a push run of the same branch and commit", { event: "push" }],
    ["a merge-queue run of the same commit", { event: "merge_group" }],
    [
      "a pull_request run on a queue branch",
      { head_branch: "gh-readonly-queue/main/pr-480-abc" },
    ],
    [
      "Pod observations (posts dev.pr_merged)",
      {
        name: "Pod observations",
        path: ".github/workflows/pod-observations.yml",
      },
    ],
    ["another workflow", { path: ".github/workflows/depends-on.yml" }],
    ["a finished run", { status: "completed" }],
    ["another branch", { head_branch: "fix/other" }],
    [
      "a fork's branch of the same name",
      { head_repository: { full_name: "someone/backend" } },
    ],
    [
      "a run another open PR shares",
      { pull_requests: [{ number: 480 }, { number: 481 }] },
    ],
    ["another PR's run", { pull_requests: [{ number: 481 }] }],
    ["an older commit naming no PR", { head_sha: "c".repeat(40) }],
  ])("never %s", (_label, over) => {
    expect(ids([run(over)])).toEqual([]);
  });

  it("never its own run, and never anything for a PR whose head is a protected branch", () => {
    expect(ids([run({ id: 7 })], 7)).toEqual([]);
    for (const headRef of ["main", "develop", "release/1.2"])
      expect(
        selectRunsToCancel({
          pr: { ...pr, headRef },
          runs: [run({ head_branch: headRef })],
        })
      ).toEqual([]);
  });
});

describe("cancel-closed-pr-runs: the workflow", () => {
  const wf = readFileSync(
    join(REPO, ".github/workflows/cancel-closed-pr-runs.yml"),
    "utf8"
  );

  it("runs on a closed pull request only, with actions: write on its one job", () => {
    expect(wf).toMatch(/^on:\n {2}pull_request:\n {4}types: \[closed\]\n/m);
    expect(wf).toMatch(/^permissions: \{\}$/m);
    // The write permission is the job's, not the workflow's.
    expect(wf).toMatch(
      /^ {4}permissions:\n(?: {6}#.*\n)* {6}actions: write\n {6}contents: read\n/m
    );
    expect(wf).toContain("run: node scripts/ci/cancel-closed-pr-runs.mjs");
    expect(wf).toContain(
      "sparse-checkout: scripts/ci/cancel-closed-pr-runs.mjs"
    );
  });
});
