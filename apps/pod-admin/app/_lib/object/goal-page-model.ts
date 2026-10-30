/**
 * The goal page's own half — only what pod-admin adds on top of the shared
 * goal model (`@synap-core/types/goal`, the desk's and the phone's). Every
 * mark, row, verb, move and verdict comes from there; this file maps them
 * onto the console's pills and words, and reads the goal's sessions.
 *
 * PURE: no React, no tRPC.
 */

import type {
  GoalMarkView,
  GoalView,
  GoalWriteResult,
} from "@synap-core/types/goal";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { UnitTone } from "@synap-core/types/units";
import type { StatusKind } from "../../(admin)/components/status-pill";
import { sessionStatusMark } from "./session-status";

/**
 * A goal mark as a console pill. The console has four pill kinds; a mark's
 * tone is the shared unit tone. A quiet tone (closed as retired, dropped)
 * reads as `unknown` (grey), never as healthy.
 */
const PILL_FOR_TONE: Record<UnitTone, StatusKind> = {
  primary: "healthy",
  ai: "healthy",
  info: "healthy",
  success: "healthy",
  warning: "stale",
  error: "down",
  textSecondary: "unknown",
  textMuted: "unknown",
};

export function goalPill(mark: GoalMarkView): {
  kind: StatusKind;
  label: string;
} {
  return { kind: PILL_FOR_TONE[mark.tone] ?? "unknown", label: mark.label };
}

/** How many sessions the page lists before "Open in app" takes over. */
export const GOAL_SESSIONS_CAP = 5;

export interface GoalSessionRow {
  id: string;
  title: string;
  status: { kind: StatusKind; label: string } | undefined;
}

/** The goal's sessions, as `focusSessions.list({ trackId })` returns them. */
export function goalSessionRows(
  sessions: ReadonlyArray<{
    id: string;
    status: string;
    title?: string | null;
    goal?: string | null;
    triage?: { pending?: boolean | null } | null;
  }>
): GoalSessionRow[] {
  return sessions.map((s) => {
    const mark = sessionStatusMark(s);
    return {
      id: s.id,
      title: resolveSessionTitle({
        title: s.title ?? null,
        goal: s.goal ?? null,
      }),
      status: mark ? { kind: mark.kind, label: mark.label } : undefined,
    };
  });
}

/**
 * What a goal write answered, said once: applied, already so, or held for
 * review (a success — never retried). `done` is the act's past-tense words
 * ("Accepted", "Paused").
 */
export function goalWriteNotice(
  done: string,
  result: GoalWriteResult
): { title: string; proposalId: string | null } {
  if (result.outcome === "proposed") {
    return {
      title: "Proposed for review — it applies once approved.",
      proposalId: result.proposalId,
    };
  }
  if (result.outcome === "unchanged") {
    return { title: "Nothing to change — it already was.", proposalId: null };
  }
  return { title: done, proposalId: null };
}

/**
 * The goal as one pasteable text: name, status, end state, every criterion
 * with its mark. What a person forwards when asked "where is this goal?".
 */
export function goalSummaryText(name: string, view: GoalView): string {
  const lines = [`${name} — ${view.header.status.label}`];
  if (view.header.purpose) lines.push(view.header.purpose);
  if (view.doneWhen.endState)
    lines.push("", `Done when: ${view.doneWhen.endState}`);
  if (view.count.label) lines.push(view.count.label);
  for (const row of view.criteria) {
    lines.push(`- [${row.mark.label}] ${row.statement}`);
  }
  return lines.join("\n");
}
