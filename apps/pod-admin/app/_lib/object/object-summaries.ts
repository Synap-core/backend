/**
 * The one-sentence summaries and run lines of the operational objects (a rule,
 * its runs, a session) — read the same in the console and on an `/open`
 * receiver, so they live with the object views, not under either route.
 */

import {
  isTerminalSessionStatus,
  OPEN_SESSION_STATUSES,
  SUSPENDED_SESSION_STATUSES,
} from "@synap-core/types/focus-sessions";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { formatRelative, oneLine } from "../../../lib/format";

const MAX_SUMMARY = 280;

/** One readable paragraph, or null. */
export function shortDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return oneLine(value, MAX_SUMMARY) || null;
}

/** The fields of an `automations` row the summary reads. */
export interface AutomationFacts {
  status: string;
  triggerType: string;
  errorMessage?: string | null;
  nextRunAt?: Date | string | null;
  runCount: number;
  failureCount: number;
}

/** One sentence on what a rule is doing right now. */
export function automationSummary(a: AutomationFacts): string {
  switch (a.status) {
    case "error":
      return a.errorMessage?.trim()
        ? `Stopped on an error: ${a.errorMessage.trim()}`
        : "Stopped on an error.";
    case "paused":
      return "Paused — it won’t run until it’s switched back on.";
    case "draft":
      return "A draft — it has never been switched on.";
    case "archived":
      return "Archived — it no longer runs.";
  }
  const when =
    a.triggerType === "cron"
      ? a.nextRunAt
        ? `Runs on a schedule; next run ${formatRelative(a.nextRunAt)}.`
        : "Runs on a schedule."
      : a.triggerType === "event"
        ? "Runs when its trigger event happens."
        : a.triggerType === "webhook"
          ? "Runs when its webhook is called."
          : "Runs when someone starts it.";
  if (a.runCount > 0 && a.failureCount > 0) {
    return `${when} ${a.failureCount} of ${a.runCount} runs failed.`;
  }
  return when;
}

/** The fields of an `automation_runs` row a run line reads. */
export interface AutomationRunFacts {
  status: string;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  errorMessage?: string | null;
  stepsCompleted?: number;
}

/** One run as a list line: when, and what went wrong (or how far it got). */
export function runLine(run: AutomationRunFacts): {
  primary: string;
  secondary: string;
} {
  const primary = `Started ${formatRelative(run.startedAt, { empty: "at an unknown time" })}`;
  const error = run.errorMessage?.trim();
  if (error) {
    return {
      primary,
      secondary: oneLine(error, 140),
    };
  }
  const steps = run.stepsCompleted ?? 0;
  const stepWord = `${steps} ${steps === 1 ? "step" : "steps"}`;
  return {
    primary,
    secondary: run.completedAt
      ? `${stepWord} · finished ${formatRelative(run.completedAt)}`
      : `${stepWord} so far`,
  };
}

/** A session not yet ended — in flight or suspended — can still be cancelled. */
const CANCELLABLE: ReadonlySet<string> = new Set([
  ...OPEN_SESSION_STATUSES,
  ...SUSPENDED_SESSION_STATUSES,
]);

export function sessionCanCancel(status: string): boolean {
  return CANCELLABLE.has(status);
}

/** Ended sessions are where an undo makes sense — their work has landed. */
export function sessionCanRevert(status: string): boolean {
  return isTerminalSessionStatus(status);
}

export interface SessionFacts {
  status: string;
  closedAt?: Date | string | null;
  liveness?:
    | { status: "ok"; lastAgentActivityAt: Date | string | null }
    | { status: "unavailable"; reason: string }
    | null;
}

/** One sentence on where a session stands. */
export function sessionSummary(s: SessionFacts): string {
  if (!CANCELLABLE.has(s.status)) {
    const when = s.closedAt ? ` ${formatRelative(s.closedAt)}` : "";
    return `${resolveStatusLabel(s.status)}${when}.`;
  }
  if (s.status === "paused") return "Paused — no agent is working on it.";
  if (s.status === "scheduled") return "Scheduled — it hasn’t started yet.";
  // A FAILED liveness read says nothing about agents — never "none yet".
  if (s.liveness?.status !== "ok") return "In progress.";
  const last = s.liveness.lastAgentActivityAt;
  return last
    ? `In progress — an agent last acted ${formatRelative(last)}.`
    : "In progress — no agent has acted on it yet.";
}
