/**
 * cancel-superseded-queue-runs.mjs cancels merge-queue runs whose entry is
 * gone. Cancelling the wrong run is far worse than missing one: a cancelled
 * live entry's run drops that PR from the queue, a cancelled push run leaves
 * main unmeasured. So the sweep is driven end to end through a fake GitHub
 * (the same three reads and one write the workflow makes), with rows built
 * from what the API returned on 2026-10-29 (queue entries #480 fc6b0590 and
 * #485 dfe0aa84; their runs 40859123516 and 40859125535 on
 * gh-readonly-queue/main/pr-<N>-<base sha>). Named `*.tripwire.test.ts` so
 * `pnpm tripwires` (CI) runs it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  liveEntryShas,
  selectSupersededQueueRuns,
  sweep,
  // @ts-expect-error — plain ESM script, no declarations
} from "./cancel-superseded-queue-runs.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const LIVE_480 = "fc6b0590143cb0c3f1613d84347cb3f1f8af1a4d";
const LIVE_485 = "dfe0aa84741693d427dfd46687b01196c48539db";
const DEAD_480 = "f6f2f5c4fe8d1a36a9fdc6a04cd51385658dfb25";
const DEAD_485 = "033914307ba49008fc3113ea858d980af7f8bc72";
const MERGED = "409270a3d988bdd8adb7bf3d9ba9b7c898e95366";
// The sweep's clock, and a run old enough to be cancelled (20 min before it).
const NOW = Date.parse("2026-10-29T11:00:00Z");
const OLD = "2026-10-29T10:40:00Z";
const ago = (ms: number) => new Date(NOW - ms).toISOString();

type Run = Record<string, unknown>;
const run = (id: number, sha: string, over: Run = {}): Run => ({
  id,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "merge_group",
  status: "in_progress",
  head_branch: `gh-readonly-queue/main/pr-480-${"d".repeat(40)}`,
  head_sha: sha,
  html_url: `https://github.com/Synap-core/backend/actions/runs/${id}`,
  created_at: OLD,
  ...over,
});
const queueBody = (shas: string[], over: Record<string, unknown> = {}) => ({
  data: {
    repository: {
      mergeQueue: {
        entries: {
          pageInfo: { hasNextPage: false },
          nodes: shas.map((oid, i) => ({
            headCommit: { oid },
            pullRequest: { number: 480 + i },
          })),
          ...over,
        },
      },
    },
  },
});

/** A fake GitHub: answers the sweep's reads, records its cancels. */
function fakeGitHub({
  runs = [] as Run[],
  queue = queueBody([LIVE_480, LIVE_485]) as unknown,
  queueStatus = 200,
  runsStatus = 200,
  compare = {} as Record<string, string | number>,
}) {
  const calls: string[] = [];
  const cancelled: number[] = [];
  const answer = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const request = async (method: string, path: string) => {
    calls.push(`${method} ${path.split("?")[0]}`);
    if (method === "GET" && path.includes("/actions/workflows/ci.yml/runs")) {
      const status = new URL(`https://x${path}`).searchParams.get("status");
      return answer(runsStatus, {
        workflow_runs: runs.filter((r) => r.status === status),
      });
    }
    if (method === "POST" && path === "/graphql")
      return answer(queueStatus, queue);
    const cmp = /\/compare\/main\.\.\.([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && cmp) {
      const v = compare[cmp[1]] ?? "diverged";
      return typeof v === "number" ? answer(v, {}) : answer(200, { status: v });
    }
    const c = /\/actions\/runs\/(\d+)\/cancel$/.exec(path);
    if (method === "POST" && c) {
      cancelled.push(Number(c[1]));
      return answer(202, {});
    }
    return answer(404, {});
  };
  return { request, calls, cancelled };
}
const go = (gh: ReturnType<typeof fakeGitHub>, extra = {}) =>
  sweep({
    request: gh.request,
    repo: "Synap-core/backend",
    selfRunId: 999,
    triggerSha: LIVE_485,
    log: () => {},
    now: NOW,
    ...extra,
  });

describe("cancel-superseded-queue-runs: the sweep, through a fake GitHub", () => {
  it("cancels the runs of entries the queue rebuilt, and only those", async () => {
    const gh = fakeGitHub({
      runs: [
        run(40859123516, LIVE_480),
        run(40859125535, LIVE_485, { status: "queued" }),
        run(40858515116, DEAD_480),
        run(40858515884, DEAD_485, { status: "waiting" }),
      ],
    });
    const r = await go(gh);
    expect(gh.cancelled.sort()).toEqual([40858515116, 40858515884]);
    expect(r.cancelled.sort()).toEqual([40858515116, 40858515884]);
  });

  it("reads the runs BEFORE the live entries (a newer entry is seen live)", async () => {
    const gh = fakeGitHub({ runs: [run(1, DEAD_480)] });
    await go(gh);
    const firstQueue = gh.calls.indexOf("POST /graphql");
    const lastRuns = gh.calls.lastIndexOf(
      "GET /repos/Synap-core/backend/actions/workflows/ci.yml/runs"
    );
    expect(firstQueue).toBeGreaterThan(lastRuns);
    expect(lastRuns).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ["the queue read failed (HTTP 502)", { queueStatus: 502 }],
    ["GraphQL errors", { queue: { errors: [{ message: "x" }] } }],
    [
      "no merge queue on main",
      { queue: { data: { repository: { mergeQueue: null } } } },
    ],
    [
      "a second page it did not read",
      { queue: queueBody([LIVE_480], { pageInfo: { hasNextPage: true } }) },
    ],
    [
      "an entry whose head commit is not a sha",
      {
        queue: queueBody([LIVE_480], {
          nodes: [
            { headCommit: { oid: LIVE_480 } },
            { headCommit: { oid: "" } },
          ],
        }),
      },
    ],
    [
      "a null entry",
      {
        queue: queueBody([LIVE_480], {
          nodes: [{ headCommit: { oid: LIVE_480 } }, null],
        }),
      },
    ],
    [
      "only unbuilt entries (every head null)",
      {
        queue: queueBody([], {
          nodes: [{ headCommit: null }, { headCommit: null }],
        }),
      },
    ],
    [
      "an empty queue (the entry that started it is not even there)",
      { queue: queueBody([]) },
    ],
    ["the run list failed", { runsStatus: 500 }],
  ])("fail-safe: %s cancels nothing", async (_label, over) => {
    const gh = fakeGitHub({
      runs: [run(1, DEAD_480), run(2, DEAD_485)],
      ...over,
    });
    const r = await go(gh);
    expect(gh.cancelled).toEqual([]);
    expect(r.reason).not.toBe("");
  });

  // The situation the sweep exists for (24 superseded runs, 29 Oct): a long
  // queue, where only the first maximumEntriesToBuild (2) entries have a
  // merge group and the rest wait with `headCommit: null`.
  it("a long queue with unbuilt (null-head) entries still sweeps", async () => {
    const gh = fakeGitHub({
      queue: queueBody([LIVE_480, LIVE_485], {
        nodes: [
          { headCommit: { oid: LIVE_480 }, pullRequest: { number: 480 } },
          { headCommit: { oid: LIVE_485 }, pullRequest: { number: 485 } },
          { headCommit: null, pullRequest: { number: 486 } },
          { headCommit: null, pullRequest: { number: 487 } },
        ],
      }),
      runs: [run(1, LIVE_480), run(2, DEAD_480), run(3, DEAD_485)],
    });
    const r = await go(gh);
    expect(gh.cancelled.sort()).toEqual([2, 3]);
    expect(r.reason).toBe("");
  });

  it("never a run created in the last 3 min (a later sweep catches it)", async () => {
    const gh = fakeGitHub({
      runs: [
        run(1, DEAD_480, { created_at: ago(3 * 60_000 - 1000) }),
        run(2, DEAD_485, { created_at: ago(3 * 60_000) }),
        run(3, DEAD_485, { created_at: "" }),
      ],
    });
    await go(gh);
    expect(gh.cancelled).toEqual([2]);
  });

  it("keeps an entry that just MERGED (its sha is on main), and one it cannot compare", async () => {
    const gh = fakeGitHub({
      runs: [run(1, MERGED), run(2, DEAD_480), run(3, DEAD_485)],
      compare: { [MERGED]: "behind", [DEAD_480]: 502, [DEAD_485]: "identical" },
    });
    const r = await go(gh);
    expect(gh.cancelled).toEqual([]);
    expect(r.kept.sort()).toEqual([1, 2, 3]);
  });

  it("--dry-run reads everything and cancels nothing", async () => {
    const gh = fakeGitHub({ runs: [run(1, DEAD_480)] });
    await go(gh, { dryRun: true });
    expect(gh.cancelled).toEqual([]);
    expect(gh.calls).toContain(
      "GET /repos/Synap-core/backend/compare/main...f6f2f5c4fe8d1a36a9fdc6a04cd51385658dfb25"
    );
  });
});

describe("cancel-superseded-queue-runs: which runs are never touched", () => {
  const live = new Set([LIVE_480, LIVE_485]);
  const ids = (runs: Run[], extra = {}) =>
    selectSupersededQueueRuns({
      runs,
      live,
      triggerSha: LIVE_485,
      selfRunId: 7,
      now: NOW,
      ...extra,
    }).map((r: { id: number }) => r.id);

  it("a superseded entry's run, queued, running or waiting", () => {
    expect(
      ids([
        run(1, DEAD_480),
        run(2, DEAD_480, { status: "queued" }),
        run(3, DEAD_485, { status: "waiting" }),
      ])
    ).toEqual([1, 2, 3]);
  });

  // Each row differs from a cancellable run by ONE field: the rule it pins
  // is the only thing that keeps it.
  it.each([
    ["a live entry's run", { head_sha: LIVE_480 }],
    ["a push run of main (same sha)", { event: "push", head_branch: "main" }],
    ["a push run, queue-shaped branch", { event: "push" }],
    ["a pull_request run", { event: "pull_request" }],
    ["another workflow", { path: ".github/workflows/pod-observations.yml" }],
    [
      "this sweep's own workflow",
      { path: ".github/workflows/cancel-superseded-queue-runs.yml" },
    ],
    ["a finished run", { status: "completed" }],
    [
      "another base's queue",
      { head_branch: `gh-readonly-queue/develop/pr-480-${"d".repeat(40)}` },
    ],
    ["not a queue branch", { head_branch: "fix/x" }],
    ["a malformed sha", { head_sha: "abc" }],
    ["its own run", { id: 7 }],
  ])("never %s", (_label, over) => {
    expect(ids([run(1, DEAD_480, over)])).toEqual([]);
  });

  it("never the run of the entry that started this sweep, even if the list missed it", () => {
    expect(ids([run(1, DEAD_485)])).toEqual([1]);
    expect(ids([run(1, DEAD_485)], { triggerSha: DEAD_485 })).toEqual([]);
  });

  it("no live list, or an empty one: nothing", () => {
    expect(ids([run(1, DEAD_480)], { live: null })).toEqual([]);
    expect(ids([run(1, DEAD_480)], { live: new Set() })).toEqual([]);
  });

  it("the live list is read whole or not at all", () => {
    expect([...liveEntryShas(queueBody([LIVE_480, LIVE_485]))]).toEqual([
      LIVE_480,
      LIVE_485,
    ]);
    expect(liveEntryShas(queueBody([]))?.size).toBe(0);
    expect(liveEntryShas(null)).toBeNull();
    expect(liveEntryShas(queueBody([LIVE_480], { pageInfo: {} }))).toBeNull();
    expect(liveEntryShas(queueBody(["nope"]))).toBeNull();
    // An unbuilt entry (null head) is skipped, the rest still read.
    expect([
      ...liveEntryShas(
        queueBody([], {
          nodes: [{ headCommit: { oid: LIVE_480 } }, { headCommit: null }],
        })
      ),
    ]).toEqual([LIVE_480]);
  });
});

describe("cancel-superseded-queue-runs: the workflow", () => {
  const wf = readFileSync(
    join(REPO, ".github/workflows/cancel-superseded-queue-runs.yml"),
    "utf8"
  );

  it("runs on merge_group only, with actions: write on its one job", () => {
    expect(wf).toMatch(
      /^on:\n {2}merge_group:\n {4}types: \[checks_requested\]\n\n/m
    );
    expect(wf).toMatch(/^permissions: \{\}$/m);
    expect(wf).toMatch(
      /^ {4}permissions:\n(?: {6}#.*\n)* {6}actions: write\n {6}contents: read\n {6}pull-requests: read\n/m
    );
    expect(wf).toContain(
      "run: node scripts/ci/cancel-superseded-queue-runs.mjs"
    );
    // The script imports the shared rules: both are checked out.
    expect(wf).toContain("scripts/ci/cancel-superseded-queue-runs.mjs\n");
    expect(wf).toContain("scripts/ci/cancel-closed-pr-runs.mjs\n");
    expect(wf).toContain(
      "TRIGGER_SHA: ${{ github.event.merge_group.head_sha }}"
    );
  });

  it("ci.yml still gives each queue run its own group (the sweep is what cancels)", () => {
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain(
      "group: ${{ github.workflow }}-${{ github.event_name == 'merge_group' && github.sha || github.ref }}"
    );
    expect(ci).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"
    );
  });
});
