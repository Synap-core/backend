/**
 * THE STATE OF A PULL REQUEST, as the pod knows it: folded from the dev-loop
 * facts it recorded (`dev.pr_opened` / `dev.pr_merged` / `dev.pr_closed`,
 * `ci.finished`, `dev.deployed`; the contract is `./dev-loop.ts`). The pod
 * reads no GitHub of its own: what it knows is what a producer posted.
 *
 * PURE: the api reads the event rows (`services/dev-loop/pr-state.ts`), this
 * file decides what they say, so every surface that shows a PR row draws the
 * same state.
 *
 * What it never does:
 *  - guess a state with no fact: no PR event recorded → `null` (the reader
 *    draws nothing), never "Open";
 *  - say checks are running: no event says CI started (only `ci.finished`);
 *  - say "not deployed": a build that does not show it contains the merge
 *    may still contain it. Deployed is stated when a deploy of the PR's repo
 *    was built from a commit made at or after the merge (`builtAt`), or
 *    names the PR's merge commit itself.
 */

import {
  DEV_LOOP_EVENT_TYPES,
  type CiFinishedStatus,
  type PullRequestRef,
  samePullRequest,
} from "./dev-loop.js";

export const PULL_REQUEST_STATES = ["open", "merged", "closed"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export const PULL_REQUEST_CHECKS = ["passed", "failed"] as const;
export type PullRequestChecks = (typeof PULL_REQUEST_CHECKS)[number];

/** What the recorded facts say about one PR. */
export interface PullRequestStateFacts {
  state: PullRequestState;
  /** The newest CI result on the PR's newest run sha; absent when none settles it. */
  checks?: PullRequestChecks;
  /**
   * A deploy contains the merge (built from a later commit of the repo, or
   * from the merge commit). Never `false`: see the file header.
   */
  deployed?: true;
  /** When the fact that set `state` happened (ISO). */
  at: string;
}

/** One recorded event, as the reader hands it over. */
export interface DevLoopEventRowLike {
  type: string;
  timestamp: Date | string;
  data: unknown;
}

const PR_EVENT_STATE: Readonly<Record<string, PullRequestState>> = {
  [DEV_LOOP_EVENT_TYPES.prOpened]: "open",
  [DEV_LOOP_EVENT_TYPES.prMerged]: "merged",
  [DEV_LOOP_EVENT_TYPES.prClosed]: "closed",
};

/**
 * Two facts at the same instant: a merge is also a close (GitHub reports
 * both), and either ends an open.
 */
const SAME_INSTANT_RANK: Readonly<Record<PullRequestState, number>> = {
  merged: 2,
  closed: 1,
  open: 0,
};

const CHECKS_OF: Partial<Record<CiFinishedStatus, PullRequestChecks>> = {
  success: "passed",
  failure: "failed",
  timed_out: "failed",
};

function record(data: unknown): Record<string, unknown> {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function time(row: DevLoopEventRowLike): number {
  return new Date(row.timestamp).getTime();
}

/** Two shas name one commit when the shorter is a prefix of the longer. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

/** Is this PR event about `ref`? */
function isAbout(ref: PullRequestRef, data: Record<string, unknown>): boolean {
  const repo = str(data.repo);
  return (
    repo !== undefined &&
    typeof data.number === "number" &&
    samePullRequest(ref, { repo, number: data.number })
  );
}

/**
 * Fold the recorded facts about `ref` into its state. `rows` may hold events
 * about other PRs and other types: only this PR's are read. `null` when no
 * `dev.pr_*` fact about it was recorded.
 */
export function foldPullRequestState(
  ref: PullRequestRef,
  rows: readonly DevLoopEventRowLike[]
): PullRequestStateFacts | null {
  let newest: {
    state: PullRequestState;
    at: number;
    sha?: string;
  } | null = null;
  const prShas: string[] = [];
  for (const row of rows) {
    const state = PR_EVENT_STATE[row.type];
    if (!state) continue;
    const data = record(row.data);
    if (!isAbout(ref, data)) continue;
    const at = time(row);
    const sha = str(data.sha);
    if (sha && state === "open") prShas.push(sha);
    if (
      !newest ||
      at > newest.at ||
      (at === newest.at &&
        SAME_INSTANT_RANK[state] > SAME_INSTANT_RANK[newest.state])
    ) {
      newest = { state, at, ...(sha ? { sha } : {}) };
    }
  }
  if (!newest) return null;

  const checks = foldChecks(ref, rows, prShas);
  const merge = newest.state === "merged" ? newest : null;
  const deployed =
    merge !== null && rows.some((row) => containsMerge(ref, merge, row));

  return {
    state: newest.state,
    ...(checks ? { checks } : {}),
    ...(deployed ? { deployed: true as const } : {}),
    at: new Date(newest.at).toISOString(),
  };
}

/**
 * Does this deploy contain the merge? Its build commit of the PR's repo was
 * made at or after the merge (`builtAt`), or it names the merge commit.
 */
function containsMerge(
  ref: PullRequestRef,
  merge: { at: number; sha?: string },
  row: DevLoopEventRowLike
): boolean {
  if (row.type !== DEV_LOOP_EVENT_TYPES.deployed) return false;
  const data = record(row.data);
  const repo = str(data.repo);
  const builtAt = str(data.builtAt);
  if (
    repo !== undefined &&
    builtAt !== undefined &&
    samePullRequest(ref, { repo, number: ref.number }) &&
    new Date(builtAt).getTime() >= merge.at
  ) {
    return true;
  }
  const sha = str(data.sha);
  return (
    merge.sha !== undefined && sha !== undefined && sameCommit(sha, merge.sha)
  );
}

/**
 * The checks on the PR's NEWEST run sha: the latest result of each workflow
 * on that sha, `failed` when any failed, `passed` when every one passed,
 * absent otherwise (a cancelled or skipped run settles nothing). A run is the
 * PR's when it names the PR number, or ran on a head sha a `dev.pr_opened`
 * named.
 */
function foldChecks(
  ref: PullRequestRef,
  rows: readonly DevLoopEventRowLike[],
  prShas: readonly string[]
): PullRequestChecks | undefined {
  const runs = rows.flatMap((row) => {
    if (row.type !== DEV_LOOP_EVENT_TYPES.ciFinished) return [];
    const data = record(row.data);
    const repo = str(data.repo);
    const sha = str(data.sha);
    if (!repo || !sha) return [];
    if (!samePullRequest(ref, { repo, number: ref.number })) return [];
    const mine =
      data.pr === ref.number || prShas.some((s) => sameCommit(s, sha));
    if (!mine) return [];
    return [
      {
        at: time(row),
        sha,
        workflow: str(data.workflow) ?? "",
        status: str(data.status) as CiFinishedStatus | undefined,
      },
    ];
  });
  if (runs.length === 0) return undefined;
  const latest = runs.reduce((a, b) => (b.at > a.at ? b : a));
  const perWorkflow = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!sameCommit(run.sha, latest.sha)) continue;
    const seen = perWorkflow.get(run.workflow);
    if (!seen || run.at > seen.at) perWorkflow.set(run.workflow, run);
  }
  const results = [...perWorkflow.values()].map((r) =>
    r.status ? CHECKS_OF[r.status] : undefined
  );
  if (results.includes("failed")) return "failed";
  if (results.length > 0 && results.every((r) => r === "passed"))
    return "passed";
  return undefined;
}
