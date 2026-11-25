/**
 * IS THE DEV FACT IN? — whether the fact a hold waits on has been posted: a
 * pause whose `until.moves` names a dev fact (`pr:` / `main:` / `job:` /
 * `ai:`, `HoldDevRef` in `lifecycle/hold.ts`) resumes when this says yes.
 *
 * PURE: the hold-resume worker reads the rows (`@synap/jobs`
 * `workers/hold-resume.ts`), this file decides what they say, with the ONE PR
 * fold (`foldPullRequestState`) for a PR.
 *
 *  - `pr:`   the PR's newest fact is `merged` (default) or `closed` (`to`). A
 *            merge the producer said went into ANOTHER branch than the
 *            default (a stacked PR) is not the merge a waiter means.
 *  - `main:` the newest `dev.repo_snapshot` of the repo OBSERVED after the
 *            pause began says `health: ok`. An older one says nothing: main
 *            may have turned red since.
 *  - `job:`  the newest `ci.finished` of the devbox job (workflow
 *            `devbox <name>`, what the devbox producer posts) that ended after
 *            the pause began; with `to`, only that verdict. Job names are
 *            reused, so an earlier run of the same name says nothing.
 *  - `ai:`   no dev event: the pod's own pull of its AI availability
 *            (`aiHoldMet`) reads AI available, checked after the pause began.
 */

import {
  holdDevMovesRef,
  holdDevRefLabel,
  parseHoldDevRef,
  type HoldDevRef,
} from "../lifecycle/hold.js";
import {
  ciVerdictOf,
  DEV_LOOP_EVENT_TYPES,
  devboxJobOf,
  devboxJobWorkflow,
  pullRequestUrl,
} from "./dev-loop.js";
import { record } from "./fact-record.js";
import { foldPullRequestState, type DevLoopEventRowLike } from "./pr-state.js";

/**
 * The hold ref (`until.moves`, in its stored spelling) a just-recorded fact may
 * resume: a PR's merge or close, a snapshot whose main is green, a devbox
 * job's end. `null` when no hold can wait on this fact. A cheap pre-filter for
 * the observation door; {@link holdDevRefMet} still decides.
 */
export function holdDevFactOf(type: string, data: unknown): string | null {
  const d = record(data);
  const repo = typeof d.repo === "string" ? d.repo : null;
  if (
    (type === DEV_LOOP_EVENT_TYPES.prMerged ||
      type === DEV_LOOP_EVENT_TYPES.prClosed) &&
    repo &&
    typeof d.number === "number"
  ) {
    return holdDevMovesRef({ kind: "pr", repo, number: d.number });
  }
  if (
    type === DEV_LOOP_EVENT_TYPES.repoSnapshot &&
    repo &&
    record(d.main).health === "ok"
  ) {
    return holdDevMovesRef({ kind: "main", repo });
  }
  const job =
    type === DEV_LOOP_EVENT_TYPES.ciFinished ? devboxJobOf(d.workflow) : null;
  if (job) return holdDevMovesRef({ kind: "job", name: job });
  return null;
}

/**
 * What a hold on a dev fact NAMES (`until.moves` = `pr:` / `main:` / `job:` /
 * `ai:`): its words (`holdDevRefLabel`: `backend#539`, `backend main`,
 * `job kit-h`, `AI availability`) and, for a PR, its page on GitHub. A repo's
 * main, a devbox job and the AI have no page the pod knows, so they are named
 * only. `null` when `moves` names no dev fact.
 */
export function holdDevRefNamed(
  moves: string
): { ref: HoldDevRef; label: string; url: string | null } | null {
  const ref = parseHoldDevRef(moves);
  if (!ref) return null;
  return {
    ref,
    label: holdDevRefLabel(ref),
    url: ref.kind === "pr" ? pullRequestUrl(ref) : null,
  };
}

function newest(
  rows: readonly DevLoopEventRowLike[],
  keep: (row: DevLoopEventRowLike, data: Record<string, unknown>) => boolean,
  timeOf: (row: DevLoopEventRowLike, data: Record<string, unknown>) => number
): { row: DevLoopEventRowLike; data: Record<string, unknown> } | null {
  let best: {
    row: DevLoopEventRowLike;
    data: Record<string, unknown>;
    at: number;
  } | null = null;
  for (const row of rows) {
    const data = record(row.data);
    if (!keep(row, data)) continue;
    const at = timeOf(row, data);
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.at) best = { row, data, at };
  }
  return best;
}

/** The dev facts a producer posts as events: every `HoldDevRef` but `ai`. */
export type HoldDevEventRef = Exclude<HoldDevRef, { kind: "ai" }>;

export function holdDevRefMet(
  ref: HoldDevEventRef,
  until: { to?: string | null },
  /** When the pause began (`RecordedHold.since`). */
  since: string,
  rows: readonly DevLoopEventRowLike[]
): boolean {
  const sinceMs = Date.parse(since);
  switch (ref.kind) {
    case "pr": {
      const facts = foldPullRequestState(ref, rows);
      if (!facts) return false;
      const want = until.to ?? "merged";
      if (facts.state !== want) return false;
      return want !== "merged" || facts.intoDefault !== false;
    }
    case "main": {
      const repo = ref.repo.toLowerCase();
      const seen = newest(
        rows,
        (row, data) =>
          row.type === DEV_LOOP_EVENT_TYPES.repoSnapshot &&
          typeof data.repo === "string" &&
          data.repo.toLowerCase() === repo &&
          typeof data.observedAt === "string" &&
          Date.parse(data.observedAt) > sinceMs,
        (_row, data) => Date.parse(data.observedAt as string)
      );
      const main = seen ? record(seen.data.main) : null;
      return main?.health === "ok";
    }
    case "job": {
      const workflow = devboxJobWorkflow(ref.name);
      const run = newest(
        rows,
        (row, data) =>
          row.type === DEV_LOOP_EVENT_TYPES.ciFinished &&
          data.workflow === workflow &&
          new Date(row.timestamp).getTime() > sinceMs,
        (row) => new Date(row.timestamp).getTime()
      );
      if (!run) return false;
      // A cancelled or skipped run has no verdict: it ended nothing a waiter means.
      const verdict = ciVerdictOf(run.data.status as string);
      if (!verdict) return false;
      return until.to == null || verdict === until.to;
    }
  }
}

/**
 * Is AI available again for a hold on `ai:available`? Yes while the pod's
 * LATEST pull reads available (`availableSince` set) and the Control Plane
 * computed that answer AFTER the pause began (`checkedAt`). Met while true,
 * not only on the transition: a pull that saw AI come back before a regrade
 * could run (the AI service's entitlement cache still refusing) must not
 * strand the hold. Only payer states hold on `ai:available` (the pull sees
 * them); the AI service's own states retry on a date instead.
 */
export function aiHoldMet(
  /** When the pause began (`RecordedHold.since`). */
  since: string,
  latest:
    { availableSince: string | null; checkedAt: string } | null | undefined
): boolean {
  if (!latest?.availableSince) return false;
  const checked = Date.parse(latest.checkedAt);
  const from = Date.parse(since);
  return Number.isFinite(checked) && Number.isFinite(from) && checked > from;
}
