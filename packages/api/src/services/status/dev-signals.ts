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
 *   main_red_unowned   main is red, nobody owns the fix (no open session
 *                      titled `main red: <repo> …`, no fix PR named in
 *                      `main.fixedBy`), for the first rung. Told to the
 *                      session of the PR that turned it red
 *                      (`main.redSince.prNumber`); with no such session there
 *                      is nobody to tell, and it is counted, never guessed.
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
    /** main: the sha that turned it red, the PR that did, and what is red. */
    redSha?: string;
    culpritLabel?: string | null;
    reason?: string | null;
  };
}

/** The repo names (lowercased, no owner) that an open `main red: <repo> …` session owns. */
export function mainRedOwnedRepos(
  titles: ReadonlyArray<string | null | undefined>
): Set<string> {
  const out = new Set<string>();
  for (const t of titles) {
    const m = /^\s*main red:\s*([A-Za-z0-9_.-]+)/i.exec(t ?? "");
    if (m) out.add(m[1]!.toLowerCase());
  }
  return out;
}

const repoName = (repo: string) =>
  (repo.split("/").pop() ?? repo).toLowerCase();

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
  opts: { now: Date; ownedMains: ReadonlySet<string> }
): DevSignalCandidate[] {
  const now = opts.now.getTime();
  const repo = snapshot.repo.toLowerCase();
  const out: DevSignalCandidate[] = [];
  const episode = (base: string, escalated: boolean) =>
    escalated ? `${base}:escalated` : base;

  for (const pr of snapshot.prs) {
    if (pr.draft || !pr.podSessionId) continue;
    const signal: DevSignal | null =
      pr.checks === "green"
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
      },
    });
  }

  const main = snapshot.main;
  const redAt = main.redSince?.at;
  if (
    main.health === "red" &&
    main.redSince &&
    redAt &&
    !main.fixedBy &&
    !opts.ownedMains.has(repoName(repo))
  ) {
    const rung = rungOf("main_red_unowned", redAt, now);
    if (rung) {
      const culprit = main.redSince.prNumber;
      const culpritSession =
        culprit === undefined
          ? null
          : (snapshot.mergedToday.find((m) => m.number === culprit)
              ?.podSessionId ?? null);
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
          reason: main.reason?.trim() || null,
        },
      });
    }
  }
  return out;
}
