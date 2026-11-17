/**
 * How a flow and a run read as rows: the pure half the rules, templates,
 * tool and run pages share (the `/runs` page itself left the console with
 * Runs, `WORK_MOVED_TO_APP`).
 *
 * Two reads, two shapes. `runs.groups` is one row per FLOW (rules and
 * templates — the ledgers whose runs instantiate something reusable), with
 * exact counts over the whole ledger. `runs.list` is one row per RUN across
 * every ledger (sessions, tools, AI turns…).
 */

import { humanizeToken, resolveObjectNoun } from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../components/status-pill";
import {
  formatRelative,
  isUuid,
  oneLine,
  shortId,
} from "../../../../lib/format";

/**
 * A ledger's noun. Registry kinds read through the vocabulary ("Rule",
 * "Process", "Tool"); a chat turn and an agent write have no object of their
 * own in the registry, so they are named for what the reader saw happen.
 */
export function flowNoun(flowType: string): string {
  switch (flowType) {
    case "chat":
      return "AI turn";
    case "agent_write":
      return "Agent write";
    default:
      return resolveObjectNoun(flowType);
  }
}

/** The `runs.groups` columns a flow row reads. */
export interface FlowGroupFacts {
  flowType: string;
  runCount: number;
  recentFailedCount: number;
  runningCount: number;
  latestStatus: string;
  latestStartedAt: Date | string;
}

/** "2 failed this week · 418 runs in all" — the flow's health, in words. */
export function flowHealthSentence(g: FlowGroupFacts): string {
  const parts: string[] = [];
  if (g.runningCount > 0) parts.push(`${g.runningCount} running now`);
  if (g.recentFailedCount > 0) {
    parts.push(`${g.recentFailedCount} failed this week`);
  } else if (g.latestStatus === "failed") {
    parts.push("Last run failed");
  } else {
    parts.push("No failures this week");
  }
  parts.push(
    `${g.runCount.toLocaleString("en-US")} ${g.runCount === 1 ? "run" : "runs"} in all`
  );
  return parts.join(" · ");
}

/** Failing NOW — the W2-calm number, never the lifetime `failedCount`. */
export function flowIsFailing(g: FlowGroupFacts): boolean {
  return g.recentFailedCount > 0;
}

/** The `runs.groups` columns a flow's health pill reads. */
export interface FlowHealthFacts {
  latestStatus: string;
  recentFailedCount: number;
  runningCount?: number;
}

/**
 * A rule's or template's pill — the ONE severity order every flow list and
 * flow page shares:
 *   its own status first (stopped on error, paused, draft, archived: however
 *   its old runs went), then never ran, then the LAST run failed (down), then
 *   failures inside the window with a clean last run (stale — it recovered),
 *   then running, then working.
 * `status` is null where the flow's own row was not read (the Runs board);
 * `group` is absent for a flow with no runs.
 */
export function flowHealthPill(
  status: string | null,
  group: FlowHealthFacts | null | undefined
): { kind: StatusKind; label: string } {
  switch (status) {
    case "error":
      return { kind: "down", label: "Stopped on error" };
    case "paused":
      return { kind: "unknown", label: "Paused" };
    case "draft":
      return { kind: "unknown", label: "Draft" };
    case "archived":
      return { kind: "unknown", label: "Archived" };
  }
  if (!group) return { kind: "unknown", label: "Never ran" };
  if (group.latestStatus === "failed") {
    return { kind: "down", label: "Failed last run" };
  }
  if (group.recentFailedCount > 0) {
    const n = group.recentFailedCount;
    return { kind: "stale", label: `${n} ${n === 1 ? "failure" : "failures"}` };
  }
  if ((group.runningCount ?? 0) > 0)
    return { kind: "healthy", label: "Running" };
  return { kind: "healthy", label: "Working" };
}

/** The `UnifiedRun` columns a run row reads. */
export interface RunFacts {
  status: string;
  startedAt: Date | string | null;
  completedAt?: Date | string | null;
  error?: string | null;
  summary?: string | null;
}

const ONE_LINE = 140;

/** A run as a line: when it started, then why it failed (or what it did). */
export function runRowSecondary(run: RunFacts): string {
  const when = `Started ${formatRelative(run.startedAt, { empty: "at an unknown time" })}`;
  const error = run.error?.trim();
  if (error) return `${when} · ${oneLine(error, ONE_LINE)}`;
  const summary = run.summary?.trim();
  if (summary) return `${when} · ${oneLine(summary, ONE_LINE)}`;
  return run.completedAt
    ? `${when} · finished ${formatRelative(run.completedAt)}`
    : when;
}

/** What a run's drawer may offer, from what the pod's doors accept. */
export function runActions(run: {
  flowType: string;
  flowId: string | null;
  status: string;
}): { cancel: boolean; runAgain: boolean } {
  return {
    // `playbookRuns.cancelRun` refuses anything not live (CONFLICT).
    cancel: run.flowType === "playbook" && run.status === "running",
    // A rule re-runs through `automations.trigger` (governed for agents).
    runAgain: run.flowType === "automation" && run.flowId !== null,
  };
}

/**
 * Who started a run. Ledgers store a user id, an agent id or a word
 * (`system`, `cron`); an id is not a name, so a stranger's id reads as "a
 * person or agent" with its short id for pasting, and the viewer reads as You.
 */
export function triggeredByLabel(
  value: string | null | undefined,
  viewerId: string | null
): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (viewerId && v === viewerId) return "You";
  if (isUuid(v)) return `A person or agent (${shortId(v)})`;
  return humanizeToken(v);
}
