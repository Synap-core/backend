/**
 * The pure half of `/runs`: which board a filter reads, how a flow and a run
 * read as rows, and whether a filtered board is complete. The page only
 * fetches and draws.
 *
 * Two reads, two shapes. `runs.groups` is one row per FLOW (rules and
 * templates — the ledgers whose runs instantiate something reusable), with
 * exact counts over the whole ledger. `runs.list` is one row per RUN across
 * every ledger (sessions, tools, AI turns…), which is what "Running" and the
 * failed-AI-turns view need: those runs have no flow to group under.
 */

import { humanizeToken, resolveObjectNoun } from "@synap-core/types/vocabulary";
import { formatRelative, shortId } from "../../../../lib/format";

export const RUN_FILTERS = [
  { key: "all", label: "All" },
  { key: "failing", label: "Failing" },
  { key: "running", label: "Running" },
  { key: "chat", label: "Failed AI turns" },
] as const;

export type RunFilter = (typeof RUN_FILTERS)[number]["key"];

export function runFilterOf(raw: string | null | undefined): RunFilter {
  return RUN_FILTERS.find((f) => f.key === raw)?.key ?? "all";
}

/** The `runs.list` input each per-run filter reads; null = the flow board. */
export function runListInput(
  filter: RunFilter
): { status: "running" } | { flowType: "chat"; status: "failed" } | null {
  switch (filter) {
    case "running":
      return { status: "running" };
    case "chat":
      return { flowType: "chat", status: "failed" };
    default:
      return null;
  }
}

/**
 * A ledger's noun. Registry kinds read through the vocabulary ("Rule",
 * "Template", "Tool"); a chat turn and an agent write have no object of their
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

/** Where a flow's own page is in the console, when it has one. */
export function flowHref(flowType: string, flowId: string): string | null {
  const id = encodeURIComponent(flowId);
  if (flowType === "automation") return `/rules/${id}`;
  if (flowType === "playbook") return `/templates/${id}`;
  return null;
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

/** Days `recentFailedCount` looks back (`RECENT_FAILURE_WINDOW_DAYS`, api). */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Has the Failing board seen every failing flow?
 *
 * Groups arrive newest latest-run first, and a flow that failed this week ran
 * this week — so once the loaded groups reach a flow whose latest run is
 * older than the window, nothing further down can be failing. Until then the
 * board must keep paging or say it may be incomplete.
 */
export function failingBoardComplete(
  loaded: readonly Pick<FlowGroupFacts, "latestStartedAt">[],
  hasMore: boolean,
  now: Date
): boolean {
  if (!hasMore) return true;
  const last = loaded.at(-1);
  if (!last) return false;
  return (
    new Date(last.latestStartedAt).getTime() < now.getTime() - RECENT_WINDOW_MS
  );
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

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ONE_LINE
    ? `${flat.slice(0, ONE_LINE).trimEnd()}…`
    : flat;
}

/** A run as a line: when it started, then why it failed (or what it did). */
export function runRowSecondary(run: RunFacts): string {
  const when = `Started ${formatRelative(run.startedAt, { empty: "at an unknown time" })}`;
  const error = run.error?.trim();
  if (error) return `${when} · ${oneLine(error)}`;
  const summary = run.summary?.trim();
  if (summary) return `${when} · ${oneLine(summary)}`;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (UUID.test(v)) return `A person or agent (${shortId(v)})`;
  return humanizeToken(v);
}
