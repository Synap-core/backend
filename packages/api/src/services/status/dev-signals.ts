/**
 * DEV SIGNALS — the status watcher's rules for development work that stands
 * still (plan 5513a09a P4.1), read off the newest `dev.repo_snapshot` of a
 * repo (`@synap-core/types`, `events/dev-loop.ts`). Each is a signal for the
 * SESSION that owns the work, the one a PR body names on its `Pod session:`
 * line (`podSessionId`):
 *
 *   pr_green_unmerged  a ready PR's checks are green, and nothing changed it
 *                      for the first rung;
 *   pr_red_idle        a ready PR's checks are red — its own red, not one it
 *                      inherits from main (`redInheritedFromMain`) — and
 *                      nothing changed it for the first rung;
 *   main_red_unowned   main is red, nobody owns the fix (no ACTIVE session
 *                      titled `main red: <repo> …` started at or after main
 *                      turned red — CI's own owner rule, `culprit-finder.mjs`
 *                      `revertDecision` — and no fix PR named in
 *                      `main.fixedBy`), for the first rung. Told to the
 *                      session of the PR that turned it red
 *                      (`main.redSince.prNumber`), read off the snapshot's
 *                      `mergedToday`, else the `dev.pr_merged` fact the
 *                      watcher found for it (`culprits`); with no such session
 *                      there is nobody to tell, and it is counted, never
 *                      guessed.
 *
 * QUIET WHILE MAIN IS RED: a green PR waits for main then (the merge queue
 * takes only a main-red fix while main is red), so "green and not merged" is
 * the queue's job, not the session's. A PR's own red still raises.
 *
 * ── The clock ──────────────────────────────────────────────────────────────
 * Every N is a rung of THE work clock (`WORK_CLOCK`), never a literal. A PR's
 * age is measured from its `updatedAt` (GitHub's: a push, a comment, a label),
 * so a change of any kind restarts it: the rule under-reports, it never says
 * "no push" about a PR that just moved. Main's age is measured from when it
 * turned red (`redSince.at`); a red main that does not say when is not
 * measured, and raises nothing.
 *
 * ── Escalate once ──────────────────────────────────────────────────────────
 * A rule raises at most twice per episode: once at its FIRST rung, in-app
 * only (never a push), and once more when it is still standing at its
 * ESCALATE rung (the watcher's push rules then apply, its backlog rule
 * included). A tick that first sees an episode already past the escalate rung
 * raises only the escalation. Nothing here closes or moves anything.
 *
 * EPISODE: the PR and its head sha (a push is a new episode); main and the sha
 * that turned it red.
 *
 * WHO IS TOLD (decision D-R3, founder 2026-11-01): a dev signal is for the
 * session's AGENT first, through its change feed (`signal_raised`); the
 * first raise tells no person. Only the escalation reaches the person
 * (`watcher.ts`, `agentOnly`). D-R2: once one repo has
 * {@link REPO_STUCK_AT} or more PRs escalated at once, the person reads ONE
 * signal for the repo ("backend: 5 PRs are stuck"), not one per PR
 * ({@link foldRepoStuck}).
 *
 * PURE: the watcher reads the snapshots and the owning sessions
 * (`watcher.ts`, `devCandidates`), this file decides what they say.
 */
import { holdDevRefLabel, type HoldDevRef } from "@synap-core/types/lifecycle";
import type { RepoSnapshotFact } from "@synap-core/types";
import { WORK_CLOCK, type WorkClockRung } from "@synap-core/types/work-clock";

export type DevSignal =
  "pr_green_unmerged" | "pr_red_idle" | "main_red_unowned";

/** Each rule's two rungs: raised in-app at `first`, escalated once at `escalate`. */
export const DEV_SIGNAL_RUNGS: Readonly<
  Record<DevSignal, { first: WorkClockRung; escalate: WorkClockRung }>
> = {
  // The merge bot enqueues a green, ready PR within minutes (a CI-path PR
  // after 2 h): a day green and unmerged is work nobody is landing.
  pr_green_unmerged: { first: "stale", escalate: "stuck" },
  // A day red with nothing pushed: nobody is fixing it.
  pr_red_idle: { first: "stale", escalate: "stuck" },
  // A red main blocks every PR of the repo: it needs an owner within the
  // quiet rung (CI names its culprit after 30 min, `red-main.yml`).
  main_red_unowned: { first: "quiet", escalate: "stale" },
};

export interface DevSignalCandidate {
  signal: DevSignal;
  /** The session told; null when the snapshot names none (main's culprit unknown). */
  sessionId: string | null;
  episodeKey: string;
  /** When the rung it is raised at was reached (ISO). */
  beganAt: string;
  /** The escalation (the second raise of its episode): it may push. */
  escalated: boolean;
  facts: {
    repo: string;
    /** The dev fact's name (`holdDevRefLabel`): `backend#539`, `backend main`. */
    label: string;
    /** When its clock started (ISO): the PR's last change, main's turn to red. */
    since: string;
    url?: string;
    number?: number;
    headSha?: string;
    /** A PR: its title (the work), capped ({@link TITLE_MAX}). */
    title?: string | null;
    /** main: the sha that turned it red, the PR that did, and what is red. */
    redSha?: string;
    culpritLabel?: string | null;
    /** main: the title of the PR that turned it red, capped. */
    culpritTitle?: string | null;
    /** main: what is red, capped ({@link REASON_MAX}). */
    reason?: string | null;
  };
}

/** A PR title in a signal's words, at most this long. */
export const TITLE_MAX = 80;
/** What is red on main, in a signal's words, at most this long. */
export const REASON_MAX = 160;

/** `text` cut to `max` characters, an ellipsis marking the cut; null when blank. */
export function capWords(
  text: string | null | undefined,
  max: number
): string | null {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** An open session that may own a red main: its title, and when it started. */
export interface MainRedOwner {
  title: string | null | undefined;
  startedAt: Date | string | null | undefined;
}

/** The repo (lowercased, no owner) a `main red: <repo> …` title names, or null. */
export function mainRedRepoOf(title: string | null | undefined): string | null {
  const m = /^\s*main red:\s*([A-Za-z0-9_.-]+)/i.exec(title ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Does an owner session own THIS red of `repo`? CI's rule (`culprit-finder.mjs`
 * `revertDecision`): an active session titled `main red: <repo> …` that
 * started at or after the red began. An older one is about an earlier red:
 * it must not silence every red after it. (The caller reads active sessions
 * only.)
 */
export function ownsMainRed(
  owners: readonly MainRedOwner[],
  repo: string,
  redAt: string
): boolean {
  const name = repoName(repo);
  const red = Date.parse(redAt);
  if (!Number.isFinite(red)) return false;
  return owners.some((o) => {
    if (mainRedRepoOf(o.title) !== name) return false;
    const started =
      o.startedAt instanceof Date
        ? o.startedAt.getTime()
        : Date.parse(String(o.startedAt ?? ""));
    return Number.isFinite(started) && !(started < red);
  });
}

/** `owner/name` → `name` (`synap-core/backend` → `backend`): a repo in a person's words. */
export const repoName = (repo: string) => repo.split("/").pop() || repo;

/** The PR that turned a repo's main red, as a `dev.pr_merged` fact named it. */
export interface CulpritFact {
  sessionId: string | null;
  title: string | null;
}

/**
 * The rung an age has reached, if any: the escalation when it is past
 * `escalate`, else the first raise when it is past `first`.
 */
function rungOf(
  signal: DevSignal,
  since: string,
  now: number
): { escalated: boolean; beganAt: string } | null {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  const { first, escalate } = DEV_SIGNAL_RUNGS[signal];
  const age = now - at;
  if (age >= WORK_CLOCK[escalate]) {
    return {
      escalated: true,
      beganAt: new Date(at + WORK_CLOCK[escalate]).toISOString(),
    };
  }
  if (age >= WORK_CLOCK[first]) {
    return {
      escalated: false,
      beganAt: new Date(at + WORK_CLOCK[first]).toISOString(),
    };
  }
  return null;
}

/** The dev signals one repo's newest snapshot says, at `now`. */
export function devSignalsOf(
  snapshot: RepoSnapshotFact,
  opts: {
    now: Date;
    /** The ACTIVE `main red: …` sessions ({@link ownsMainRed}). */
    owners: readonly MainRedOwner[];
    /**
     * The culprit PR's `dev.pr_merged` fact, by PR number, for a culprit the
     * snapshot's `mergedToday` does not name (merged before today).
     */
    culprits?: ReadonlyMap<number, CulpritFact>;
  }
): DevSignalCandidate[] {
  const now = opts.now.getTime();
  const repo = snapshot.repo.toLowerCase();
  const out: DevSignalCandidate[] = [];
  const episode = (base: string, escalated: boolean) =>
    escalated ? `${base}:escalated` : base;
  const main = snapshot.main;
  const mainRed = main.health === "red";

  for (const pr of snapshot.prs) {
    if (pr.draft || !pr.podSessionId) continue;
    const signal: DevSignal | null =
      // While main is red the queue holds every green PR for main.
      pr.checks === "green" && !mainRed
        ? "pr_green_unmerged"
        : pr.checks === "red" && pr.redInheritedFromMain !== true
          ? "pr_red_idle"
          : null;
    if (!signal) continue;
    const rung = rungOf(signal, pr.updatedAt, now);
    if (!rung) continue;
    const ref: HoldDevRef = { kind: "pr", repo, number: pr.number };
    out.push({
      signal,
      sessionId: pr.podSessionId.toLowerCase(),
      episodeKey: episode(
        `${repo}#${pr.number}@${pr.headSha.toLowerCase()}`,
        rung.escalated
      ),
      beganAt: rung.beganAt,
      escalated: rung.escalated,
      facts: {
        repo,
        label: holdDevRefLabel(ref),
        since: pr.updatedAt,
        url: pr.url,
        number: pr.number,
        headSha: pr.headSha,
        title: capWords(pr.title, TITLE_MAX),
      },
    });
  }

  const redAt = main.redSince?.at;
  if (
    mainRed &&
    main.redSince &&
    redAt &&
    !main.fixedBy &&
    !ownsMainRed(opts.owners, repo, redAt)
  ) {
    const rung = rungOf("main_red_unowned", redAt, now);
    if (rung) {
      const culprit = main.redSince.prNumber;
      const today =
        culprit === undefined
          ? undefined
          : snapshot.mergedToday.find((m) => m.number === culprit);
      const fact =
        culprit === undefined ? undefined : opts.culprits?.get(culprit);
      const culpritSession = today?.podSessionId ?? fact?.sessionId ?? null;
      const culpritTitle = today?.title ?? fact?.title ?? null;
      out.push({
        signal: "main_red_unowned",
        sessionId: culpritSession?.toLowerCase() ?? null,
        episodeKey: episode(
          `${repo}@${main.redSince.sha.toLowerCase()}`,
          rung.escalated
        ),
        beganAt: rung.beganAt,
        escalated: rung.escalated,
        facts: {
          repo,
          label: holdDevRefLabel({ kind: "main", repo }),
          since: redAt,
          redSha: main.redSince.sha,
          culpritLabel:
            culprit === undefined
              ? null
              : holdDevRefLabel({ kind: "pr", repo, number: culprit }),
          culpritTitle: capWords(culpritTitle, TITLE_MAX),
          reason: capWords(main.reason, REASON_MAX),
        },
      });
    }
  }
  return out;
}

/** The red-main culprits a snapshot names but whose session it does not say. */
export function culpritsToLookUp(snapshot: RepoSnapshotFact): number | null {
  const main = snapshot.main;
  const culprit = main.redSince?.prNumber;
  if (main.health !== "red" || culprit === undefined) return null;
  const today = snapshot.mergedToday.find((m) => m.number === culprit);
  return today?.podSessionId ? null : culprit;
}

/** D-R2: this many PRs of one repo escalated at once read as ONE signal. */
export const REPO_STUCK_AT = 3;

/** What a PR signal says when its repo is folded (D-R2). */
export interface RepoStuckFold {
  /** How many PRs of the repo are escalated at once. */
  count: number;
  /** Their names (`holdDevRefLabel`), lowest number first, at most 5. */
  labels: string[];
}

/** The dev signals about one PR (the others are about a repo's main). */
export const PR_SIGNALS: ReadonlySet<string> = new Set<DevSignal>([
  "pr_green_unmerged",
  "pr_red_idle",
]);

/** The needs-you collapse key of a repo's escalated PR signals (D-R2). */
export const devPrsGroupKey = (repo: string) => `status-signal:dev-prs:${repo}`;

/**
 * D-R2: the repos with {@link REPO_STUCK_AT} or more ESCALATED PR signals
 * standing at once, each with its fold. The first raise is the agent's
 * (D-R3), so only escalations are counted: they are what a person reads.
 * Pure; keyed by the snapshot's lowercased repo.
 */
export function repoStuckFolds(
  candidates: ReadonlyArray<
    Pick<DevSignalCandidate, "signal" | "escalated" | "facts">
  >
): Map<string, RepoStuckFold> {
  const byRepo = new Map<string, Array<{ number: number; label: string }>>();
  for (const c of candidates) {
    if (!c.escalated || !PR_SIGNALS.has(c.signal)) continue;
    const list = byRepo.get(c.facts.repo) ?? [];
    list.push({ number: c.facts.number ?? 0, label: c.facts.label });
    byRepo.set(c.facts.repo, list);
  }
  const out = new Map<string, RepoStuckFold>();
  for (const [repo, list] of byRepo) {
    if (list.length < REPO_STUCK_AT) continue;
    const sorted = [...list].sort((a, b) => a.number - b.number);
    out.set(repo, {
      count: sorted.length,
      labels: sorted.slice(0, 5).map((p) => p.label),
    });
  }
  return out;
}
