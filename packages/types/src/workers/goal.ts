/**
 * `@synap-core/types/workers/goal` — a GOAL's runs in one reading, rolled up
 * from its workers (goals that run, plan 1ad1cecc): what the Goals list row
 * and the goal header show — rhythm, health, the last runs, what waits on you,
 * the next run. ONE derivation: the pod computes it for `tracks.list`
 * (`include: ["runs"]`) and a page holding the workers may call it too; never
 * a second rollup on a surface.
 */
import {
  RUN_HEALTH_MARK_LIMIT,
  goalRunHealth,
  type GoalWorkerView,
  type RunHealthState,
  type RunMarkEntry,
} from "./health.js";
import { goalRhythmWords } from "./words.js";

export interface GoalRunsRollup {
  /** "Every Monday at 09:00 UTC · when an issue is created"; null = nothing wakes it. */
  rhythm: string | null;
  /** The goal's ONE health state (`goalRunHealth`). */
  health: RunHealthState;
  /** Workers enabled on the goal, paused ones included. */
  workerCount: number;
  /** Of those, the ones not paused. */
  runningCount: number;
  /** Runs of its workers waiting on a person's approval. */
  pendingApprovals: number;
  /** The goal's newest runs across its workers, oldest → newest (≤ 10). */
  marks: RunMarkEntry[];
  /** ISO, the newest run of any worker; null = never ran. */
  lastRunAt: string | null;
  /** ISO, the soonest scheduled run of a running worker; null = none on a clock. */
  nextRunAt: string | null;
}

type RollupWorker = Pick<
  GoalWorkerView,
  | "state"
  | "profileSlug"
  | "activator"
  | "pendingApprovals"
  | "lastRunAt"
  | "nextRunAt"
  | "health"
>;

const latest = (xs: (string | null)[], pick: "max" | "min"): string | null =>
  xs.reduce<string | null>((best, x) => {
    if (!x) return best;
    if (!best) return x;
    return (pick === "max" ? x > best : x < best) ? x : best;
  }, null);

/** A goal's runs, rolled up from ITS workers (`workers.list({ trackId })`). */
export function goalRunsRollup(
  workers: readonly RollupWorker[]
): GoalRunsRollup {
  const running = workers.filter((w) => w.state === "running");
  const marks = workers
    .flatMap((w) => w.health.marks)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-RUN_HEALTH_MARK_LIMIT);
  return {
    rhythm: goalRhythmWords(workers),
    health: goalRunHealth(workers),
    workerCount: workers.length,
    runningCount: running.length,
    pendingApprovals: workers.reduce((n, w) => n + w.pendingApprovals, 0),
    marks,
    lastRunAt: latest(
      workers.map((w) => w.lastRunAt),
      "max"
    ),
    nextRunAt: latest(
      running.map((w) => w.nextRunAt),
      "min"
    ),
  };
}
