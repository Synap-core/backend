/**
 * WORK › SHIP — "can I release, and what blocks it", as ONE pure fold.
 *
 * The pod reads no GitHub of its own. A producer (the devbox) posts one
 * `dev.repo_snapshot` per repository (the contract: `events/dev-loop.ts`
 * `repoSnapshotEventSchema`); the api reads the newest per repo under the
 * reader's event floor, joins the reader's sessions and their liveness
 * (`api services/dev-loop/work-release.ts`), and THIS file decides what they
 * say. Every surface (browser Work › Ship, pod-admin, MCP) draws the same
 * stages, verdicts, folds and blockers because none of them derives its own.
 *
 * The rules:
 *  - STAGE: `on_main` = merged today; `ready` = checks green + mergeable clean
 *    + not a draft; `working` = a draft, or no checks yet (`none`); `checks` =
 *    everything else (queued, running, red, did not run, or green but not
 *    mergeable clean: a green PR that cannot merge is not ready).
 *  - VERDICT: the producer's check state, with a red split by red-vs-main:
 *    `inherited` when every failing check also fails on main, else `own_red`.
 *  - BLOCKED BY: the PRs a body names ("depends on #n"), still open; and an
 *    inherited red is blocked by its repo's MAIN. A red main is blocked by the
 *    PR that fixes it (`main.fixedBy`), when the producer named one.
 *  - BLOCKERS: every ref something waits on, plus every red main, ordered by
 *    how much waits behind it TRANSITIVELY (open PRs + mains), most first.
 *    A tie puts the root first (a blocker that waits on nothing open): the
 *    thing to act on.
 *  - HOLDER: the session holding the PR, `live` by THE "working now" rule
 *    (`isSessionWorkingNow`, run-activity/live.ts: a turn in flight or session
 *    activity in the last 5 min). The signal is the pod's own session
 *    activity; it is never inferred from the session's status.
 *
 * ONE PR FACT MODEL (plan P1.2): what the pod RECORDED about a PR
 * (`foldPullRequestState`: `dev.pr_*` and `ci.finished`, the same fold the
 * session packet and the change feed read) wins over the snapshot where it
 * speaks: a PR the facts say merged or closed is no longer open (merged into
 * the default branch: `on_main`, at the fact's time; closed, or merged into
 * another branch: off the board, blocking nothing), and checks the facts
 * settled on the PR's CURRENT head sha are its checks (a recorded failure is
 * red; a recorded pass never hides a red the snapshot saw, `checksOf`). The
 * snapshot keeps
 * main's health and what no fact carries: the open-PR list itself, draft,
 * mergeable, queued / running, red-vs-main, depends-on, auto-merge, titles.
 *
 * EMPTY ≠ FAILED: a sessions, holders or PR facts read that FAILED is passed
 * as `null` and reads `unavailable` in `sources`; an empty list is a real
 * "none".
 */

import {
  samePullRequest,
  type PrCheckState,
  type PullRequestRef,
  type RepoSnapshotFact,
} from "../events/dev-loop.js";
import {
  pullRequestKey,
  sameCommit,
  type PullRequestStateFacts,
} from "../events/pr-state.js";
import {
  isSessionWorkingNow,
  type SessionLiveFacts,
} from "../run-activity/live.js";

export {
  DEV_LOOP_EVENT_TYPES,
  PR_CHECK_STATES,
  PR_MERGEABLE_STATES,
  REPO_HEALTH_SOURCES,
  REPO_LIVE_KINDS,
  REPO_MAIN_HEALTHS,
  repoSnapshotEventSchema,
  type PrCheckState,
  type PrMergeableState,
  type RepoHealthSource,
  type RepoLiveKind,
  type RepoMainHealth,
  type RepoSnapshotFact,
} from "../events/dev-loop.js";

/** The observation type the producer posts. */
export const REPO_SNAPSHOT_EVENT_TYPE = "dev.repo_snapshot";

// ── The read ────────────────────────────────────────────────────────────────

/** The road to main, left to right. Main health and Live are per repo. */
export const SHIP_STAGES = ["working", "checks", "ready", "on_main"] as const;
export type ShipStage = (typeof SHIP_STAGES)[number];

export const CHECK_VERDICTS = [
  "green",
  "own_red",
  "inherited",
  "infra",
  "queued",
  "running",
  "unmeasured",
] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

/** Folded into counts by default; `null` = shown. */
export const SHIP_FOLDS = ["draft", "negctl", "dependabot", "stale"] as const;
export type ShipFold = (typeof SHIP_FOLDS)[number] | null;

export type BlockRef =
  { kind: "pr"; repo: string; number: number } | { kind: "main"; repo: string };

export const WORK_RELEASE_SOURCE_STATES = {
  snapshots: ["ok", "stale", "missing"],
  sessions: ["ok", "unavailable"],
  holders: ["ok", "unavailable"],
  pullRequests: ["ok", "unavailable"],
} as const;

export interface WorkReleaseSources {
  /** `stale` = the newest snapshot is older than {@link SNAPSHOT_STALE_MS}. */
  snapshots: (typeof WORK_RELEASE_SOURCE_STATES.snapshots)[number];
  sessions: (typeof WORK_RELEASE_SOURCE_STATES.sessions)[number];
  holders: (typeof WORK_RELEASE_SOURCE_STATES.holders)[number];
  /** The recorded PR facts; `unavailable` = the rows are the snapshot's alone. */
  pullRequests: (typeof WORK_RELEASE_SOURCE_STATES.pullRequests)[number];
}

export interface WorkReleaseRepo {
  /** `owner/name`, as the producer spelled it. */
  repo: string;
  /** The name without its owner: `backend`. */
  label: string;
  visibility: "public" | "private";
  main: RepoSnapshotFact["main"];
  live: NonNullable<RepoSnapshotFact["live"]> | null;
  snapshotAt: string | null;
}

export interface WorkReleaseHolder {
  /** A session holding the PR is working on it now (`isSessionWorkingNow`). */
  live: boolean;
  /** Who holds it: the session's agent, else its owner. */
  label: string;
  /** The session's newest activity; null when nothing was recorded. */
  lastActiveAt: string | null;
}

export interface WorkReleasePr {
  repo: string;
  number: number;
  title: string;
  url: string;
  stage: ShipStage;
  verdict: CheckVerdict;
  fold: ShipFold;
  sessionId: string | null;
  sessionTitle: string | null;
  /** `null` when no session holds it, or the holders read failed (`sources`). */
  holder: WorkReleaseHolder | null;
  /** Explicit `dependsOn` still open, then (inherited red) its repo's main. */
  blockedBy: BlockRef[];
  /** Auto-merge is armed: green + clean merges it with no one. */
  autoMerge: boolean;
  updatedAt: string;
  mergedAt?: string | null;
}

export interface WorkReleaseBlocker {
  ref: BlockRef;
  /** Open PRs + mains waiting behind it, transitively. */
  waiting: number;
  waitingPrs: number;
  waitingMains: number;
  /** A main: its `reason`; a PR: its title. */
  reason: string | null;
  /** A main: the PR that fixes it, when named. Absent on a PR. */
  fixedBy?: BlockRef | null;
}

export interface WorkReleaseRead {
  generatedAt: string;
  sources: WorkReleaseSources;
  repos: WorkReleaseRepo[];
  prs: WorkReleasePr[];
  /** The blocker with the most waiting behind it, transitively, first. */
  blockers: WorkReleaseBlocker[];
}

// ── The fold's inputs (besides the snapshots) ──────────────────────────────

/** One of the reader's sessions that a PR may belong to. */
export interface WorkReleaseSessionInput {
  id: string;
  title: string | null;
  /** The PRs it declared as outcomes (`ref.url`): trusted before a body line. */
  pullRequests?: readonly PullRequestRef[];
}

/** Who holds a session and its liveness facts (`loadSessionLiveness`). */
export interface WorkReleaseHolderInput {
  sessionId: string;
  label: string;
  live: SessionLiveFacts;
}

export interface FoldWorkReleaseOptions {
  /** The clock (default: now). Staleness and liveness are judged against it. */
  now?: Date | number | string;
  /**
   * What the pod recorded about the PRs (`readPullRequestStates`, keyed by
   * `pullRequestKey`); `null` when that read FAILED. Absent = none recorded.
   */
  pullRequests?: ReadonlyMap<string, PullRequestStateFacts> | null;
}

/** A recorded fact that ends a PR, as the board reads it. */
function endedByFact(
  facts: PullRequestStateFacts | undefined
): "on_main" | "gone" | null {
  if (!facts || facts.state === "open") return null;
  return facts.state === "merged" && facts.intoDefault !== false
    ? "on_main"
    : "gone";
}

/**
 * A PR's checks: the facts settled on its CURRENT head (`headSha`) over the
 * snapshot's word, with one floor — a red, or checks that did not run, the
 * snapshot saw are never turned green by a recorded pass. The producer reads
 * EVERY check; a recorded pass may cover fewer (one workflow, one devbox
 * gate), so it can only settle what the snapshot had not settled yet.
 */
function checksOf(
  snapshot: PrCheckState,
  facts: PullRequestStateFacts | undefined,
  headSha: string
): PrCheckState {
  if (!facts?.checks || !facts.checksOn) return snapshot;
  if (!sameCommit(facts.checksOn, headSha)) return snapshot;
  if (facts.checks === "failed") return "red";
  return snapshot === "red" || snapshot === "infra" ? snapshot : "green";
}

/** A snapshot older than this (the newest one) reads `stale`. */
export const SNAPSHOT_STALE_MS = 30 * 60_000;
/** An open PR untouched this long folds as `stale`. */
export const STALE_PR_MS = 7 * 24 * 60 * 60_000;

const STAGE_ORDER: Readonly<Record<ShipStage, number>> = {
  working: 0,
  checks: 1,
  ready: 2,
  on_main: 3,
};

function timeOf(value: Date | number | string | undefined): number {
  if (value === undefined) return Date.now();
  return value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : new Date(value).getTime();
}

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const repoKey = (repo: string) => repo.toLowerCase();
const prKey = (repo: string, number: number) => `pr:${repoKey(repo)}#${number}`;
const mainKey = (repo: string) => `main:${repoKey(repo)}`;
const refKey = (ref: BlockRef) =>
  ref.kind === "pr" ? prKey(ref.repo, ref.number) : mainKey(ref.repo);

function repoLabel(repo: string): string {
  const slash = repo.indexOf("/");
  return slash === -1 ? repo : repo.slice(slash + 1);
}

/** The verdict a check state reads as. A red splits by red-vs-main. */
export function checkVerdictOf(
  checks: PrCheckState,
  redInheritedFromMain: boolean | undefined
): CheckVerdict {
  switch (checks) {
    case "green":
      return "green";
    case "red":
      return redInheritedFromMain ? "inherited" : "own_red";
    case "infra":
      return "infra";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "none":
      return "unmeasured";
  }
}

/** The stage of an OPEN PR (a merged one is `on_main`). */
export function shipStageOf(pr: {
  draft: boolean;
  checks: PrCheckState;
  mergeable: RepoSnapshotFact["prs"][number]["mergeable"];
}): ShipStage {
  if (pr.draft || pr.checks === "none") return "working";
  if (pr.checks === "green" && pr.mergeable === "clean") return "ready";
  return "checks";
}

const NEGCTL_RE = /^negctl/i;
const DEPENDABOT_RE = /^dependabot(\[bot\])?$/i;

/** Which fold an open PR goes into; `null` = shown. First match wins. */
export function shipFoldOf(
  pr: {
    title: string;
    branch?: string;
    author: string;
    draft: boolean;
    updatedAt: string;
  },
  now: number
): ShipFold {
  if (NEGCTL_RE.test(pr.title) || (pr.branch && NEGCTL_RE.test(pr.branch))) {
    return "negctl";
  }
  if (DEPENDABOT_RE.test(pr.author)) return "dependabot";
  if (pr.draft) return "draft";
  const updated = Date.parse(pr.updatedAt);
  if (Number.isFinite(updated) && now - updated > STALE_PR_MS) return "stale";
  return null;
}

/** The newest snapshot per repo (case-insensitive); a later tie wins. */
function newestPerRepo(
  snapshots: readonly RepoSnapshotFact[]
): RepoSnapshotFact[] {
  const byRepo = new Map<string, RepoSnapshotFact>();
  for (const s of snapshots) {
    const seen = byRepo.get(repoKey(s.repo));
    if (!seen || Date.parse(s.observedAt) >= Date.parse(seen.observedAt)) {
      byRepo.set(repoKey(s.repo), s);
    }
  }
  return [...byRepo.values()];
}

/**
 * The session a PR belongs to: the ONE session that declared it as an outcome
 * (the resolver's first join, `pr-session-resolver.ts`), else the body's
 * `Pod session:` line. Several outcome matches: the body line breaks the tie
 * when it names one of them, else none (never a guess).
 */
function sessionOf(
  ref: PullRequestRef,
  podSessionId: string | null | undefined,
  sessions: readonly WorkReleaseSessionInput[] | null
): string | null {
  const named = podSessionId ? podSessionId.toLowerCase() : null;
  const declared = (sessions ?? []).filter((s) =>
    (s.pullRequests ?? []).some((p) => samePullRequest(p, ref))
  );
  if (declared.length === 1) return declared[0]!.id;
  if (declared.length > 1) {
    return declared.find((s) => s.id.toLowerCase() === named)?.id ?? null;
  }
  return named;
}

/**
 * THE fold. `sessions` / `holders` are `null` when their read FAILED (the
 * read says `unavailable`), an array (maybe empty) when it answered.
 */
export function foldWorkRelease(
  snapshots: readonly RepoSnapshotFact[],
  sessions: readonly WorkReleaseSessionInput[] | null,
  holders: readonly WorkReleaseHolderInput[] | null,
  options: FoldWorkReleaseOptions = {}
): WorkReleaseRead {
  const now = timeOf(options.now);
  const latest = newestPerRepo(snapshots).sort((a, b) =>
    repoLabel(a.repo).localeCompare(repoLabel(b.repo))
  );
  const byRepo = new Map(latest.map((s) => [repoKey(s.repo), s]));

  const newestAt = latest.reduce(
    (max, s) => Math.max(max, Date.parse(s.observedAt)),
    Number.NEGATIVE_INFINITY
  );
  const sources: WorkReleaseSources = {
    snapshots:
      latest.length === 0
        ? "missing"
        : now - newestAt > SNAPSHOT_STALE_MS
          ? "stale"
          : "ok",
    sessions: sessions === null ? "unavailable" : "ok",
    holders: holders === null ? "unavailable" : "ok",
    pullRequests: options.pullRequests === null ? "unavailable" : "ok",
  };
  const facts = options.pullRequests ?? new Map();
  const factsOf = (ref: PullRequestRef) => facts.get(pullRequestKey(ref));

  const titleOf = new Map(
    (sessions ?? []).map((s) => [s.id.toLowerCase(), s.title])
  );
  const holderOf = new Map(
    (holders ?? []).map((h) => [h.sessionId.toLowerCase(), h])
  );
  const join = (sessionId: string | null) => {
    if (!sessionId) return { sessionTitle: null, holder: null };
    const h = holderOf.get(sessionId.toLowerCase());
    return {
      sessionTitle: titleOf.get(sessionId.toLowerCase()) ?? null,
      holder: h
        ? {
            live: isSessionWorkingNow(h.live, now),
            label: h.label,
            lastActiveAt: iso(h.live.lastAt),
          }
        : null,
    };
  };

  // Open on its repo's newest snapshot / merged today: what a dependsOn
  // edge can still wait on (a PR of an OBSERVED repo that is neither was
  // merged before today or closed — it blocks nothing).
  // A PR the recorded facts ended is neither, whatever the snapshot says.
  const openPrs = new Set<string>();
  const mergedPrs = new Set<string>();
  for (const s of latest) {
    for (const m of s.mergedToday) mergedPrs.add(prKey(s.repo, m.number));
    for (const p of s.prs) {
      const key = prKey(s.repo, p.number);
      if (mergedPrs.has(key)) continue;
      if (endedByFact(factsOf({ repo: s.repo, number: p.number }))) continue;
      openPrs.add(key);
    }
  }
  const stillBlocks = (ref: PullRequestRef) => {
    const key = prKey(ref.repo, ref.number);
    if (openPrs.has(key)) return true;
    if (mergedPrs.has(key)) return false;
    if (endedByFact(factsOf(ref))) return false;
    return !byRepo.has(repoKey(ref.repo));
  };

  const prs: WorkReleasePr[] = [];
  /** waiter key → the keys it waits on. */
  const waitsOn = new Map<string, BlockRef[]>();

  for (const s of latest) {
    for (const p of s.prs) {
      const key = prKey(s.repo, p.number);
      if (mergedPrs.has(key)) continue;
      const ref = { repo: s.repo, number: p.number };
      const recorded = factsOf(ref);
      const ended = endedByFact(recorded);
      if (ended === "gone") continue;
      if (ended === "on_main") {
        // Merged, and the snapshot has not caught up: drawn as merged.
        const sessionId = sessionOf(ref, p.podSessionId, sessions);
        prs.push({
          repo: s.repo,
          number: p.number,
          title: p.title,
          url: p.url,
          stage: "on_main",
          verdict: "green",
          fold: NEGCTL_RE.test(p.title) ? "negctl" : null,
          sessionId,
          ...join(sessionId),
          blockedBy: [],
          autoMerge: false,
          updatedAt: recorded!.at,
          mergedAt: recorded!.at,
        });
        continue;
      }
      const checks = checksOf(p.checks, recorded, p.headSha);
      const verdict = checkVerdictOf(checks, p.redInheritedFromMain);
      const blockedBy: BlockRef[] = [];
      const seen = new Set<string>();
      for (const d of p.dependsOn ?? []) {
        const dep: BlockRef = { kind: "pr", repo: d.repo, number: d.number };
        if (seen.has(refKey(dep)) || refKey(dep) === key) continue;
        if (!stillBlocks(d)) continue;
        seen.add(refKey(dep));
        blockedBy.push(dep);
      }
      if (verdict === "inherited") {
        blockedBy.push({ kind: "main", repo: s.repo });
      }
      if (blockedBy.length > 0) waitsOn.set(key, blockedBy);
      const sessionId = sessionOf(ref, p.podSessionId, sessions);
      prs.push({
        repo: s.repo,
        number: p.number,
        title: p.title,
        url: p.url,
        stage: shipStageOf({ ...p, checks }),
        verdict,
        fold: shipFoldOf(p, now),
        sessionId,
        ...join(sessionId),
        blockedBy,
        autoMerge: p.autoMerge,
        updatedAt: p.updatedAt,
        mergedAt: null,
      });
    }
    for (const m of s.mergedToday) {
      const ref = { repo: s.repo, number: m.number };
      const sessionId = sessionOf(ref, m.podSessionId, sessions);
      prs.push({
        repo: s.repo,
        number: m.number,
        title: m.title,
        url: m.url,
        stage: "on_main",
        verdict: "green",
        fold: NEGCTL_RE.test(m.title) ? "negctl" : null,
        sessionId,
        ...join(sessionId),
        blockedBy: [],
        autoMerge: false,
        updatedAt: m.mergedAt,
        mergedAt: m.mergedAt,
      });
    }
    // A red main waits on the PR that fixes it, while that PR is open.
    const fix = s.main.fixedBy;
    if (s.main.health === "red" && fix && stillBlocks(fix)) {
      waitsOn.set(mainKey(s.repo), [
        { kind: "pr", repo: fix.repo, number: fix.number },
      ]);
    }
  }

  prs.sort(
    (a, b) =>
      repoLabel(a.repo).localeCompare(repoLabel(b.repo)) ||
      STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] ||
      b.number - a.number
  );

  return {
    generatedAt: new Date(now).toISOString(),
    sources,
    repos: latest.map((s) => ({
      repo: s.repo,
      label: repoLabel(s.repo),
      visibility: s.visibility,
      main: s.main,
      live: s.live ?? null,
      snapshotAt: s.observedAt,
    })),
    prs,
    blockers: rankBlockers(latest, prs, waitsOn),
  };
}

/**
 * Every ref something waits on, plus every red main, with how much waits
 * behind it transitively. Waiters counted: OPEN PRs and mains (a merged PR
 * waits on nothing). Cycles are walked once.
 */
function rankBlockers(
  latest: readonly RepoSnapshotFact[],
  prs: readonly WorkReleasePr[],
  waitsOn: ReadonlyMap<string, BlockRef[]>
): WorkReleaseBlocker[] {
  const refs = new Map<string, BlockRef>();
  const waitersOf = new Map<string, string[]>();
  for (const [waiter, targets] of waitsOn) {
    for (const t of targets) {
      const k = refKey(t);
      if (!refs.has(k)) refs.set(k, t);
      waitersOf.set(k, [...(waitersOf.get(k) ?? []), waiter]);
    }
  }
  for (const s of latest) {
    if (s.main.health === "red" && !refs.has(mainKey(s.repo))) {
      refs.set(mainKey(s.repo), { kind: "main", repo: s.repo });
    }
  }

  const prByKey = new Map(prs.map((p) => [prKey(p.repo, p.number), p]));
  const mainOf = new Map(latest.map((s) => [mainKey(s.repo), s.main]));
  const isOpenPr = (k: string) => {
    const p = prByKey.get(k);
    return p !== undefined && p.stage !== "on_main";
  };

  const ranked = [...refs].map(([key, ref]) => {
    const behind = new Set<string>();
    const queue = [...(waitersOf.get(key) ?? [])];
    while (queue.length > 0) {
      const w = queue.shift()!;
      if (behind.has(w) || w === key) continue;
      behind.add(w);
      queue.push(...(waitersOf.get(w) ?? []));
    }
    const waitingPrs = [...behind].filter(isOpenPr).length;
    const waitingMains = [...behind].filter((k) =>
      k.startsWith("main:")
    ).length;
    const main = ref.kind === "main" ? mainOf.get(key) : undefined;
    const blocker: WorkReleaseBlocker = {
      ref,
      waiting: waitingPrs + waitingMains,
      waitingPrs,
      waitingMains,
      reason:
        ref.kind === "main"
          ? (main?.reason ?? null)
          : (prByKey.get(key)?.title ?? null),
      ...(ref.kind === "main"
        ? {
            fixedBy: main?.fixedBy
              ? {
                  kind: "pr" as const,
                  repo: main.fixedBy.repo,
                  number: main.fixedBy.number,
                }
              : null,
          }
        : {}),
    };
    // A root waits on nothing open: it is where the work is.
    const root = !(waitsOn.get(key) ?? []).length;
    return { key, blocker, root };
  });

  ranked.sort(
    (a, b) =>
      b.blocker.waiting - a.blocker.waiting ||
      Number(b.root) - Number(a.root) ||
      (a.blocker.ref.kind === b.blocker.ref.kind
        ? 0
        : a.blocker.ref.kind === "main"
          ? -1
          : 1) ||
      a.key.localeCompare(b.key)
  );
  return ranked.map((r) => r.blocker);
}
