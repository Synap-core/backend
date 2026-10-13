/**
 * Sessions — which segment a session belongs to, and how its row reads.
 *
 * PURE (the clock is a parameter), so the segment rules are tested at the seam
 * and the page only renders what this returns.
 *
 * The segments, and the one read behind each:
 *   running  open (`active` · `forming` · `paused`) and not stuck
 *   stuck    open, not paused, started more than STUCK_AFTER_HOURS ago, and
 *            no agent working on it right now
 *   waiting  sessions with a slot owed by the viewer (`focusSessions.owed`)
 *   idle     `stale` — the reaper found it quiet for 30 days
 *   closed   `closed` · `cancelled` · `failed`
 *
 * "Stuck" uses diagnose's `stuck_runs` boundary (`classifyRunStall`'s `aged`
 * verdict: still running past 24h since it started) so Home's "N runs still
 * going after 24h" and this list draw the line in the same place. Two
 * refinements, both of which only REMOVE rows diagnose would count: a session
 * an agent is demonstrably working on right now (`isSessionWorkingNow`, the D1
 * rule) is not stuck, and neither is one a person paused on purpose.
 * Appointments (`scheduled`) are not runs at all — the run ledger excludes
 * them too — so they appear in no segment.
 */

import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  isSessionWorkingNow,
  type SessionLiveFacts,
} from "@synap-core/types/run-activity";
import { formatRelative } from "../../../../lib/format";
import { statusPillFor } from "../../components/status-tone";
import type { StatusKind } from "../../components/status-pill";

// Here, not in the client page: the server `page.tsx` renders them in its
// Suspense fallback, and a "use client" module's exports are references there.
export const SESSIONS_TITLE = "Sessions";
export const SESSIONS_DESCRIPTION =
  "Every piece of work on the pod — what is running, what is stuck, and what is waiting on you.";

export type SessionSegment =
  "running" | "stuck" | "waiting" | "idle" | "closed";

export const SESSION_SEGMENTS: ReadonlyArray<{
  key: SessionSegment;
  label: string;
}> = [
  { key: "running", label: "Running" },
  { key: "stuck", label: "Stuck" },
  { key: "waiting", label: "Waiting on you" },
  { key: "idle", label: "Idle 30d+" },
  { key: "closed", label: "Closed" },
];

/** The URL param the segment lives in (`/sessions?filter=stuck`). */
export const SEGMENT_PARAM = "filter";

export function segmentOf(raw: string | null | undefined): SessionSegment {
  return SESSION_SEGMENTS.find((s) => s.key === raw)?.key ?? "running";
}

/**
 * diagnose's `DEFAULT_STUCK_THRESHOLD_HOURS`
 * (packages/api/src/services/diagnose/types.ts). A console cannot import the
 * API package; the two must be changed together.
 */
export const STUCK_AFTER_HOURS = 24;

/** The statuses the Running and Stuck segments are read from, in one query. */
export const OPEN_RUN_STATUSES = ["active", "forming", "paused"] as const;
export const IDLE_STATUSES = ["stale"] as const;
export const CLOSED_STATUSES = ["closed", "cancelled", "failed"] as const;

/** The fields a `focusSessions.browse` row carries that a row reads. */
export interface SessionLike {
  id: string;
  title?: string | null;
  goal?: string | null;
  status: string;
  startedAt: Date | string;
  updatedAt: Date | string;
  closedAt?: Date | string | null;
  workspaceId: string | null;
  projectId: string | null;
  /** The owner. */
  userId: string;
  viewerRole?: "owner" | "member";
  verdict?: {
    state: "none" | "passing" | "failing" | "incomplete";
    total: number;
    passed: number;
  };
  /** `null` = the liveness read FAILED; absent = not requested. */
  live?: SessionLiveFacts | null;
}

function timeOf(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** True when an open session belongs in Stuck rather than Running. */
export function isStuck(s: SessionLike, now: number): boolean {
  if (!(OPEN_RUN_STATUSES as readonly string[]).includes(s.status))
    return false;
  if (s.status === "paused") return false;
  const started = timeOf(s.startedAt);
  if (started === null) return false;
  if (now - started <= STUCK_AFTER_HOURS * 3_600_000) return false;
  // A failed liveness read (`null`) proves nothing either way; age decides.
  return !isSessionWorkingNow(s.live, now);
}

/** Split one open-sessions page into the two segments it feeds. */
export function splitOpen<T extends SessionLike>(
  rows: readonly T[],
  now: number
): { running: T[]; stuck: T[] } {
  const running: T[] = [];
  const stuck: T[] = [];
  for (const r of rows) (isStuck(r, now) ? stuck : running).push(r);
  return { running, stuck };
}

export type SessionAct = "pause" | "resume" | "close";

/**
 * The owner's acts on a row: one primary, at most one quieter secondary.
 * Pausing and closing are the owner's (`viewerRole`, decision C) — a member
 * of a shared session gets none rather than buttons that fail. Terminal
 * sessions have nothing left to do from a list.
 */
export function sessionActs(
  status: string,
  segment: SessionSegment,
  viewerRole: SessionLike["viewerRole"]
): { primary: SessionAct | null; secondary: SessionAct | null } {
  const none = { primary: null, secondary: null };
  if (viewerRole !== "owner") return none;
  const pausable = status === "active" || status === "forming";
  const resumable = status === "paused" || status === "stale";
  if (!pausable && !resumable) return none;
  const toggle: SessionAct = pausable ? "pause" : "resume";
  // Where the list is about tidying (stuck, idle) the close comes first.
  return segment === "stuck" || segment === "idle"
    ? { primary: "close", secondary: toggle }
    : { primary: toggle, secondary: "close" };
}

export const ACT_LABEL: Record<SessionAct, string> = {
  pause: "Pause",
  resume: "Resume",
  close: "Close",
};

export interface SessionRow {
  id: string;
  title: string;
  secondary: string;
  pill: { kind: StatusKind; label: string } | null;
  status: string;
  acts: { primary: SessionAct | null; secondary: SessionAct | null };
}

export interface Names {
  workspaces: ReadonlyMap<string, string>;
  projects: ReadonlyMap<string, string>;
  /** Pod members by user id — who owns a session shared with the viewer. */
  people: ReadonlyMap<string, string>;
}

/** "Builder › Launch", "Builder", or null when neither is known. */
export function whereOf(
  s: { workspaceId: string | null; projectId: string | null },
  names: Names
): string | null {
  const space = s.workspaceId ? names.workspaces.get(s.workspaceId) : null;
  const project = s.projectId ? names.projects.get(s.projectId) : null;
  if (space && project) return `${space} › ${project}`;
  return space ?? project ?? null;
}

/**
 * The criteria verdict when the session declares criteria (what "done" means
 * for it); otherwise its lifecycle, with "Working" when an agent is on it now.
 */
export function sessionPill(
  s: SessionLike,
  now: number
): { kind: StatusKind; label: string } | null {
  const v = s.verdict;
  if (v && v.state !== "none") {
    if (v.state === "passing")
      return { kind: "healthy", label: "Criteria met" };
    if (v.state === "failing")
      return { kind: "down", label: "Criteria failing" };
    return { kind: "stale", label: `${v.passed}/${v.total} criteria` };
  }
  if (s.status === "active" && isSessionWorkingNow(s.live, now))
    return { kind: "healthy", label: "Working" };
  return statusPillFor(s.status);
}

export function sessionRow(
  s: SessionLike,
  segment: SessionSegment,
  names: Names,
  now: number
): SessionRow {
  const settled = segment === "closed" && s.closedAt;
  const secondary = [
    whereOf(s, names),
    `started ${formatRelative(s.startedAt)}`,
    settled
      ? `ended ${formatRelative(s.closedAt)}`
      : `last activity ${formatRelative(s.updatedAt)}`,
    s.viewerRole === "member"
      ? `${names.people.get(s.userId) ?? "someone else"}’s, shared with you`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: s.id,
    title: resolveSessionTitle(s) || "Untitled session",
    secondary,
    pill: sessionPill(s, now),
    status: s.status,
    acts: sessionActs(s.status, segment, s.viewerRole),
  };
}

/** One owed slot (`focusSessions.owed`), reduced to what a row reads. */
export interface OwedSlotLike {
  sessionId: string;
  sessionTitle: string | null;
  sessionStatus: string;
  workspaceId: string | null;
  projectId: string | null;
  label: string;
  owedSince: string;
}

/**
 * Owed slots → one row per session, oldest owed first (the order the door
 * returns). The owed door is owner-floored, so every row is the viewer's own.
 */
export function waitingRows(
  slots: readonly OwedSlotLike[],
  names: Names
): SessionRow[] {
  const bySession = new Map<string, OwedSlotLike[]>();
  for (const s of slots) {
    const list = bySession.get(s.sessionId) ?? [];
    list.push(s);
    bySession.set(s.sessionId, list);
  }
  return [...bySession.values()].map((group) => {
    const first = group[0]!;
    const labels = group.map((g) => g.label);
    const owed =
      labels.length === 1
        ? `owes “${labels[0]}”`
        : `owes ${labels.length}: ${labels.slice(0, 2).join(", ")}${labels.length > 2 ? "…" : ""}`;
    return {
      id: first.sessionId,
      title: first.sessionTitle || "Untitled session",
      secondary: [
        whereOf(first, names),
        owed,
        `since ${formatRelative(first.owedSince)}`,
      ]
        .filter(Boolean)
        .join(" · "),
      pill: {
        kind: "stale",
        label: labels.length === 1 ? "1 owed" : `${labels.length} owed`,
      },
      status: first.sessionStatus,
      acts: sessionActs(first.sessionStatus, "waiting", "owner"),
    };
  });
}
