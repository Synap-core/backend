import { describe, it, expect } from "vitest";
import {
  DEV_LOOP_EVENT_TYPES as T,
  foldPullRequestState,
  sameCommit,
  type DevLoopEventRowLike,
} from "../index.js";
import {
  PULL_REQUEST_CHECKS_LABELS,
  PULL_REQUEST_STATE_LABELS,
  resolvePullRequestStateLabel,
} from "../vocabulary/index.js";

const REF = { repo: "Synap-core/backend", number: 285 };
const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 10, min));
const HEAD = "d7e01700a5f860ea52015459760c2a4061be5d7d";
const HEAD2 = "f7d736fb1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE = "a2dd31c0d0000000000000000000000000000000";

function pr(
  type: string,
  min: number,
  over: Record<string, unknown> = {}
): DevLoopEventRowLike {
  return {
    type,
    timestamp: at(min),
    data: {
      repo: "Synap-core/backend",
      number: 285,
      url: "https://github.com/Synap-core/backend/pull/285",
      ...over,
    },
  };
}
function ci(
  min: number,
  status: string,
  over: Record<string, unknown> = {}
): DevLoopEventRowLike {
  return {
    type: T.ciFinished,
    timestamp: at(min),
    data: { repo: "Synap-core/backend", sha: HEAD, status, ...over },
  };
}

function started(
  min: number,
  over: Record<string, unknown> = {}
): DevLoopEventRowLike {
  return {
    type: T.ciStarted,
    timestamp: at(min),
    data: { repo: "Synap-core/backend", sha: HEAD, ...over },
  };
}

describe("foldPullRequestState — what the recorded facts say about one PR", () => {
  it("no PR fact recorded: null, never a guessed 'open' (CI or deploy rows alone say nothing)", () => {
    expect(foldPullRequestState(REF, [])).toBeNull();
    expect(
      foldPullRequestState(REF, [
        ci(1, "success", { pr: 285 }),
        {
          type: T.deployed,
          timestamp: at(2),
          data: { target: "x", sha: HEAD },
        },
      ])
    ).toBeNull();
  });

  it("the NEWEST fact sets the state, with its time; another PR's facts are ignored", () => {
    const rows = [
      pr(T.prOpened, 1, { sha: HEAD }),
      pr(T.prMerged, 9, { number: 284 }),
      pr(T.prClosed, 9, { repo: "Synap-core/app-bases" }),
    ];
    expect(foldPullRequestState(REF, rows)).toEqual({
      state: "open",
      at: at(1).toISOString(),
    });
    expect(
      foldPullRequestState(REF, [...rows, pr(T.prMerged, 5, { sha: MERGE })])
    ).toMatchObject({ state: "merged", at: at(5).toISOString() });
  });

  it("a reopened PR is open again; the repo is matched whatever its case", () => {
    expect(
      foldPullRequestState(REF, [
        pr(T.prOpened, 1, { repo: "synap-core/BACKEND" }),
        pr(T.prClosed, 2),
        pr(T.prOpened, 3),
      ])
    ).toMatchObject({ state: "open", at: at(3).toISOString() });
  });

  it("merged and closed at the same instant: merged (a merge is also a close)", () => {
    expect(
      foldPullRequestState(REF, [pr(T.prClosed, 4), pr(T.prMerged, 4)])
    ).toMatchObject({ state: "merged" });
    expect(
      foldPullRequestState(REF, [pr(T.prMerged, 4), pr(T.prClosed, 4)])
    ).toMatchObject({ state: "merged" });
  });

  it("checks: the latest result of EACH workflow on the newest sha — one failure fails it", () => {
    const opened = pr(T.prOpened, 1, { sha: HEAD });
    const fold = (...runs: DevLoopEventRowLike[]) =>
      foldPullRequestState(REF, [opened, ...runs])?.checks;
    // CI failed, then docs passed later: still failed ("newest run" would say passed).
    expect(
      fold(
        ci(2, "failure", { workflow: "CI", pr: 285 }),
        ci(3, "success", { workflow: "Reference docs", pr: 285 })
      )
    ).toBe("failed");
    expect(
      fold(
        ci(2, "success", { workflow: "CI", pr: 285 }),
        ci(3, "success", { workflow: "Reference docs", pr: 285 })
      )
    ).toBe("passed");
    // A re-run of the same workflow on the same sha supersedes its failure.
    expect(
      fold(
        ci(2, "failure", { workflow: "CI", pr: 285 }),
        ci(4, "success", { workflow: "CI", pr: 285 })
      )
    ).toBe("passed");
    // A newer sha's runs supersede the old sha's.
    expect(
      fold(
        ci(2, "failure", { workflow: "CI", pr: 285 }),
        ci(5, "success", { workflow: "CI", pr: 285, sha: HEAD2 })
      )
    ).toBe("passed");
    expect(fold(ci(2, "timed_out", { pr: 285 }))).toBe("failed");
  });

  it("checks absent when nothing settles them: cancelled / skipped, or no run at all", () => {
    const opened = pr(T.prOpened, 1, { sha: HEAD });
    expect(foldPullRequestState(REF, [opened])).not.toHaveProperty("checks");
    expect(
      foldPullRequestState(REF, [opened, ci(2, "cancelled", { pr: 285 })])
    ).not.toHaveProperty("checks");
  });

  it("a run is the PR's by its number OR its head sha; another PR's run, or another repo's, is not", () => {
    const opened = pr(T.prOpened, 1, { sha: HEAD });
    // No `pr` field, but it ran on the PR's head sha (7-char prefix).
    expect(
      foldPullRequestState(REF, [
        opened,
        ci(2, "failure", { sha: HEAD.slice(0, 7) }),
      ])?.checks
    ).toBe("failed");
    expect(
      foldPullRequestState(REF, [
        opened,
        ci(2, "failure", { pr: 284, sha: HEAD2 }),
        ci(3, "failure", { repo: "Synap-core/app-bases", pr: 285 }),
      ])
    ).not.toHaveProperty("checks");
  });

  it("deployed ONLY when a deploy names the merge commit; never stated false", () => {
    const merged = pr(T.prMerged, 5, { sha: MERGE });
    const deploy = (sha: string): DevLoopEventRowLike => ({
      type: T.deployed,
      timestamp: at(6),
      data: { target: "pod.example", sha },
    });
    expect(
      foldPullRequestState(REF, [merged, deploy(MERGE.slice(0, 9))])
    ).toMatchObject({ state: "merged", deployed: true });
    // A later build (another sha) may or may not contain it: not stated.
    expect(
      foldPullRequestState(REF, [merged, deploy(HEAD2)])
    ).not.toHaveProperty("deployed");
    // An open PR's head being deployed is not "the PR deployed".
    expect(
      foldPullRequestState(REF, [
        pr(T.prOpened, 1, { sha: MERGE }),
        deploy(MERGE),
      ])
    ).not.toHaveProperty("deployed");
  });

  it("deployed when a build of the PR's repo was made from a commit at or after the merge (builtAt)", () => {
    const merged = pr(T.prMerged, 5, { sha: MERGE });
    const build = (
      builtMin: number,
      over: Record<string, unknown> = {}
    ): DevLoopEventRowLike => ({
      type: T.deployed,
      timestamp: at(30),
      data: {
        target: "pod.example",
        sha: HEAD2,
        repo: "synap-core/BACKEND",
        builtAt: at(builtMin).toISOString(),
        ...over,
      },
    });
    // A later commit of the repo contains the merge; the same instant too.
    expect(foldPullRequestState(REF, [merged, build(9)])).toMatchObject({
      deployed: true,
    });
    expect(foldPullRequestState(REF, [merged, build(5)])).toMatchObject({
      deployed: true,
    });
    // Built from a commit made BEFORE the merge (a nightly of an older green
    // commit): it does not contain it, however late it was deployed.
    expect(foldPullRequestState(REF, [merged, build(4)])).not.toHaveProperty(
      "deployed"
    );
    // A build of another repo says nothing about this repo's merge.
    expect(
      foldPullRequestState(REF, [
        merged,
        build(9, { repo: "Synap-core/app-bases" }),
      ])
    ).not.toHaveProperty("deployed");
    // No repo named: only the sha can say it.
    expect(
      foldPullRequestState(REF, [merged, build(9, { repo: undefined })])
    ).not.toHaveProperty("deployed");
    // Unreadable time: nothing stated.
    expect(
      foldPullRequestState(REF, [merged, build(9, { builtAt: "soon" })])
    ).not.toHaveProperty("deployed");
    // An open PR is never deployed, whatever was built after it opened.
    expect(
      foldPullRequestState(REF, [pr(T.prOpened, 1, { sha: HEAD }), build(9)])
    ).not.toHaveProperty("deployed");
  });

  it("ci.started: running until its workflow finishes on that sha; a settled failure stays failed", () => {
    const opened = pr(T.prOpened, 1, { sha: HEAD });
    const fold = (...runs: DevLoopEventRowLike[]) =>
      foldPullRequestState(REF, [opened, ...runs]);
    // Started, nothing finished: running, no verdict yet.
    expect(fold(started(2, { workflow: "CI", pr: 285 }))).toEqual({
      state: "open",
      checksOn: HEAD,
      checksRunning: true,
      at: at(1).toISOString(),
    });
    // Its finish ends it.
    const done = fold(
      started(2, { workflow: "CI", pr: 285 }),
      ci(4, "success", { workflow: "CI", pr: 285 })
    );
    expect(done).toMatchObject({ checks: "passed", checksOn: HEAD });
    expect(done).not.toHaveProperty("checksRunning");
    // One workflow passed, another still running: not passed yet.
    const half = fold(
      ci(3, "success", { workflow: "CI", pr: 285 }),
      started(4, { workflow: "Reference docs", pr: 285 })
    );
    expect(half).toMatchObject({ checksRunning: true, checksOn: HEAD });
    expect(half).not.toHaveProperty("checks");
    // A failure already settled stays failed while another runs.
    expect(
      fold(
        ci(3, "failure", { workflow: "CI", pr: 285 }),
        started(4, { workflow: "Reference docs", pr: 285 })
      )
    ).toMatchObject({ checks: "failed", checksRunning: true });
    // A re-run of a finished workflow runs again.
    expect(
      fold(
        ci(3, "failure", { workflow: "CI", pr: 285 }),
        started(5, { workflow: "CI", pr: 285 })
      )
    ).toMatchObject({ checksRunning: true });
    // A start and a finish at the same instant: the finish.
    expect(
      fold(
        started(3, { workflow: "CI", pr: 285 }),
        ci(3, "success", { workflow: "CI", pr: 285 })
      )
    ).not.toHaveProperty("checksRunning");
    // A push: the newer sha's start supersedes the old sha's verdict.
    const pushed = fold(
      ci(3, "success", { workflow: "CI", pr: 285 }),
      started(6, { workflow: "CI", pr: 285, sha: HEAD2 })
    );
    expect(pushed).toMatchObject({ checksRunning: true, checksOn: HEAD2 });
    expect(pushed).not.toHaveProperty("checks");
    // Another PR's start, or another repo's, is not this PR's.
    expect(
      fold(
        started(2, { pr: 284, sha: HEAD2 }),
        started(3, { repo: "Synap-core/app-bases", pr: 285 })
      )
    ).not.toHaveProperty("checksRunning");
  });

  it("dev.merge_queued: queued while open and not reopened since; merged or closed ends it", () => {
    const opened = pr(T.prOpened, 1, { sha: HEAD });
    const queued = pr(T.mergeQueued, 3, { sha: HEAD });
    expect(foldPullRequestState(REF, [opened, queued])).toEqual({
      state: "open",
      queued: true,
      at: at(1).toISOString(),
    });
    // A queue entry never sets the state on its own: no PR fact, no state.
    expect(foldPullRequestState(REF, [queued])).toBeNull();
    // It does not move the state's time either.
    expect(foldPullRequestState(REF, [opened, queued])?.at).toBe(
      at(1).toISOString()
    );
    // Merged (out of the queue) or closed: no longer queued.
    const merged = foldPullRequestState(REF, [
      opened,
      queued,
      pr(T.prMerged, 6, { sha: MERGE }),
    ]);
    expect(merged).toMatchObject({ state: "merged" });
    expect(merged).not.toHaveProperty("queued");
    expect(
      foldPullRequestState(REF, [opened, queued, pr(T.prClosed, 6)])
    ).not.toHaveProperty("queued");
    // Closed, then reopened after it was queued: not queued until re-queued.
    const reopened = [opened, queued, pr(T.prClosed, 5), pr(T.prOpened, 7)];
    expect(foldPullRequestState(REF, reopened)).not.toHaveProperty("queued");
    expect(
      foldPullRequestState(REF, [...reopened, pr(T.mergeQueued, 8)])
    ).toMatchObject({ state: "open", queued: true });
    // Another PR's queue entry is not this PR's.
    expect(
      foldPullRequestState(REF, [opened, pr(T.mergeQueued, 3, { number: 284 })])
    ).not.toHaveProperty("queued");
  });

  it("sameCommit: a short sha names the long one, case-insensitive; different shas differ", () => {
    expect(sameCommit("A2DD31C", MERGE)).toBe(true);
    expect(sameCommit(MERGE, "a2dd31c0d")).toBe(true);
    expect(sameCommit("a2dd31d", MERGE)).toBe(false);
  });
});

describe("the PR state words (one door, @synap-core/types/vocabulary)", () => {
  it("every state and check result has its word", () => {
    expect(PULL_REQUEST_STATE_LABELS).toEqual({
      open: "Open",
      merged: "Merged",
      closed: "Closed",
    });
    expect(PULL_REQUEST_CHECKS_LABELS).toEqual({
      passed: "Checks passed",
      failed: "Checks failed",
    });
    expect(resolvePullRequestStateLabel("merged")).toBe("Merged");
  });
});
