/**
 * The pure half of the "Serves goal" and "Health" columns of Automations and
 * Templates: what a row says about the goal it serves, and how its runs are
 * doing, read from the backend's own `servesGoal` / `servesGoals` /
 * `runHealth` (`@synap-core/types/workers/health` `RunHealth`). Nothing here
 * derives health: the state and the marks arrive from the pod's one
 * derivation; this only words them and picks their tone.
 */

import {
  RUN_HEALTH_MARK_LIMIT,
  type RunHealth,
  type RunHealthState,
  type RunMark,
} from "@synap-core/types/workers/health";
import type { StatusKind } from "../../components/status-pill";

/** A goal a worker serves (the row's `servesGoal`, an entry of `servesGoals`). */
export interface ServedGoalFacts {
  id: string;
  name: string;
}

/** What the "Serves goal" cell draws: one named door, or "None". */
export type ServesGoalCell =
  | { kind: "none"; label: "None" }
  | { kind: "goals"; first: ServedGoalFacts; more: number };

export function servesGoalCell(
  goals: ServedGoalFacts | readonly ServedGoalFacts[] | null | undefined
): ServesGoalCell {
  const list = !goals ? [] : Array.isArray(goals) ? goals : [goals];
  const [first, ...rest] = list as ServedGoalFacts[];
  return first
    ? { kind: "goals", first, more: rest.length }
    : { kind: "none", label: "None" };
}

/** The cell as text (the phone line, a title): "Win the launch +2". */
export function servesGoalText(cell: ServesGoalCell): string {
  return cell.kind === "none"
    ? "Serves no goal"
    : `Serves ${cell.first.name}${cell.more > 0 ? ` +${cell.more}` : ""}`;
}

const STATE_VIEW: Record<
  RunHealthState,
  { kind: StatusKind; label: string; meaning: string }
> = {
  failing: {
    kind: "down",
    label: "Failing",
    meaning: "On, and its last run failed.",
  },
  off: {
    kind: "down",
    label: "Turned off",
    meaning: "The pod stopped it after failures in a row. Fix it, then resume.",
  },
  waiting: {
    kind: "stale",
    label: "Waiting on you",
    meaning: "On, and runs wait for a person to approve or answer.",
  },
  healthy: {
    kind: "healthy",
    label: "Healthy",
    meaning: "On, and nothing is wrong. No run yet counts as healthy.",
  },
  paused: {
    kind: "unknown",
    label: "Paused",
    meaning: "A person paused it.",
  },
  not_running: {
    kind: "unknown",
    label: "Not running",
    meaning: "On, but nothing fires it.",
  },
};

/** Every state with its words, in the order the legend reads. */
export const RUN_HEALTH_LEGEND: ReadonlyArray<{
  state: RunHealthState;
  kind: StatusKind;
  label: string;
  meaning: string;
}> = (
  ["healthy", "waiting", "failing", "off", "paused", "not_running"] as const
).map((state) => ({ state, ...STATE_VIEW[state] }));

const MARK_WORDS: Record<RunMark, string> = {
  done: "Done",
  failed: "Failed",
  waiting: "Waiting on a person",
  skipped: "Skipped",
  running: "Running",
};

export interface RunHealthCell {
  kind: StatusKind;
  label: string;
  /** The last runs, oldest first, each worded for its tooltip. */
  strip: Array<{ runId: string; mark: RunMark; title: string }>;
  /** One sentence for the phone line and the title. */
  sentence: string;
}

/**
 * The "Health" cell. `null` health (a row the pod gave none) reads "No health
 * yet" — unknown, never a guessed "Healthy".
 */
export function runHealthCell(
  health: RunHealth | null | undefined
): RunHealthCell {
  if (!health) {
    return {
      kind: "unknown",
      label: "No health yet",
      strip: [],
      sentence: "No health yet",
    };
  }
  const view = STATE_VIEW[health.state];
  const strip = health.marks.slice(-RUN_HEALTH_MARK_LIMIT).map((m) => ({
    runId: m.runId,
    mark: m.mark,
    title: `${MARK_WORDS[m.mark]} · ${m.at}`,
  }));
  const detail =
    health.state === "off" && health.offReason
      ? health.offReason
      : health.state === "failing" && health.consecutiveFailures > 1
        ? `${health.consecutiveFailures} failures in a row`
        : null;
  return {
    kind: view.kind,
    label: view.label,
    strip,
    sentence: detail ? `${view.label} · ${detail}` : view.label,
  };
}
