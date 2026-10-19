/**
 * The Home brief's READS → its input, and the Home sections' pure rows —
 * shared by the desktop (browser `HomeWork`) and the phone (relay Home), so
 * neither surface counts a clause, a move or a project's state its own way.
 * (Moved here from browser `home-brief-model.ts`, RL-HOME 2026-10-19.)
 *
 *   - the sentence           → `homeBrief` over `homeBriefInputOf` below
 *   - the next three moves   → `homeMoves` over rows already filed and ordered
 *                              by `needsYouBuckets` (the Inbox's rule)
 *   - a project's state      → `projectAggregateInput` / `resolveUnitState`
 *                              (`../units`), led by the SAME needs-you count
 *                              the Inbox and the rail show
 *
 * Every count keeps "unread" apart from zero: a failed read is `null`, which
 * the brief drops and flags, never a calm 0.
 */
import { lensCountDoorText } from "./header.js";
import type { HomeBriefCount, HomeBriefInput } from "./home-brief.js";
import {
  pathRowSessionFact,
  projectAggregateInput,
  type UnitStateInput,
} from "../units/index.js";
import { isTerminalSessionStatus } from "../focus-sessions/statuses.js";
import { resolveSessionTitle } from "../focus-sessions/title.js";
import type { NeedsYouBucket } from "../needs-you/buckets.js";

/** "Your next three moves". */
export const HOME_MOVES_CAP = 3;
/** "Where your projects stand" rows before "Show all N". */
export const HOME_PROJECTS_CAP = 5;

/** A read as the brief needs it: loading, failed, or its answer. */
export type BriefRead<T> =
  { status: "loading" } | { status: "failed" } | { status: "ready"; data: T };

const UNKNOWN: HomeBriefCount = { count: null };

/** The needs-you page's bucket counts; a full page is a floor ("100+"). */
function bucketCount(
  read: BriefRead<{ counts: Record<NeedsYouBucket, number>; capped: boolean }>,
  bucket: NeedsYouBucket
): HomeBriefCount {
  return read.status === "ready"
    ? { count: read.data.counts[bucket], floor: read.data.capped }
    : UNKNOWN;
}

export interface HomeBriefReads {
  lastSeen: string | null;
  /** The pod's needs-you page, filed by the shared buckets. */
  needsYou: BriefRead<{ counts: Record<NeedsYouBucket, number>; capped: boolean }>;
  /** `outputs.landed` since the window start (actor: agents). */
  produced: BriefRead<{
    items: readonly unknown[];
    nextCursor: string | null;
    truncated: boolean;
  }>;
  /** Per-project needs-you counts (`signals.countByProject`). */
  projectCounts: BriefRead<
    ReadonlyArray<{ status: string; count?: { needsYou: number } }>
  >;
  /** `lifecycle.moving`. */
  moving: BriefRead<MovingRead>;
}

export interface MovingRead {
  items: ReadonlyArray<{
    work: ReadonlyArray<{ sessionId: string; live: boolean }>;
  }>;
  unattached: ReadonlyArray<{ sessionId: string; live: boolean }>;
}

/** Sessions an agent is on RIGHT NOW — each counted once, wherever it shows. */
export function liveSessionCount(moving: MovingRead): number {
  const live = new Set<string>();
  for (const item of moving.items)
    for (const w of item.work) if (w.live) live.add(w.sessionId);
  for (const w of moving.unattached) if (w.live) live.add(w.sessionId);
  return live.size;
}

/** The instant "finished" is counted from: the last visit, else today's start. */
export function homeBriefSince(
  lastSeen: string | null,
  dayStart: string | number
): string {
  return lastSeen ?? new Date(dayStart).toISOString();
}

/**
 * The brief's input from Home's reads. A read in flight returns `null`: the
 * sentence waits (a skeleton) rather than speaking from half its counts.
 */
export function homeBriefInputOf(reads: HomeBriefReads): HomeBriefInput | null {
  const all = [
    reads.needsYou,
    reads.produced,
    reads.projectCounts,
    reads.moving,
  ];
  if (all.some((r) => r.status === "loading")) return null;
  const projectsHeldUp: HomeBriefCount =
    reads.projectCounts.status === "ready" &&
    reads.projectCounts.data.every((r) => r.status === "ok")
      ? {
          count: reads.projectCounts.data.filter(
            (r) => (r.count?.needsYou ?? 0) > 0
          ).length,
        }
      : UNKNOWN;
  return {
    since: reads.lastSeen ? "last-seen" : "today",
    produced:
      reads.produced.status === "ready"
        ? {
            count: reads.produced.data.items.length,
            floor:
              reads.produced.data.nextCursor !== null ||
              reads.produced.data.truncated,
          }
        : UNKNOWN,
    decisions: bucketCount(reads.needsYou, "decision"),
    questions: bucketCount(reads.needsYou, "question"),
    failed: bucketCount(reads.needsYou, "broken"),
    projectsHeldUp,
    working:
      reads.moving.status === "ready"
        ? { count: liveSessionCount(reads.moving.data) }
        : UNKNOWN,
  };
}

/**
 * "Your next three moves": the Inbox's own order, routine changes held back
 * for their one batch line (they are approved together, from the Inbox).
 */
export function homeMoves<R extends { bucket: NeedsYouBucket }>(model: {
  rows: readonly R[];
  counts: Record<NeedsYouBucket, number>;
}): { moves: R[]; routine: number } {
  return {
    moves: model.rows
      .filter((r) => r.bucket !== "routine")
      .slice(0, HOME_MOVES_CAP),
    routine: model.counts.routine,
  };
}

// ── Where your projects stand ───────────────────────────────────────────────

export interface ProjectLite {
  id: string;
  name: string;
  colorSlot?: number | null;
}

/** An open session as `focusSessions.list({ nextMove: true })` returns it. */
export interface OpenSessionLite {
  id: string;
  projectId?: string | null;
  status: string;
  title?: string | null;
  goal?: string | null;
  unitFacts?: Parameters<typeof pathRowSessionFact>[0]["unitFacts"];
  nextMove?: { actor?: "user" | "ai" | "none" } | null;
  live?: Parameters<typeof pathRowSessionFact>[0]["live"];
}

export interface ProjectStandRow {
  project: ProjectLite;
  state: UnitStateInput;
  /** The one line under the name ("3 need you", the work in hand); null = none. */
  nextLine: string | null;
}

/**
 * One row per active project: the SAME needs-you count the Inbox shows leads
 * (`owedFromYou`); else the ONE project rule over its open sessions
 * (`projectAggregateInput` — working vs quiet by `isSessionWorkingNow`); a
 * project with nothing open is quiet. Unread counts read `unmeasured`.
 * Ordered: waiting on you (most first), then working, then the rest.
 */
export function projectStandRows(
  projects: readonly ProjectLite[],
  counts: BriefRead<
    ReadonlyArray<{
      projectId: string;
      status: string;
      count?: { needsYou: number; truncated?: boolean };
    }>
  >,
  sessions: BriefRead<readonly OpenSessionLite[]>
): ProjectStandRow[] {
  const byProject = new Map<
    string,
    { needsYou: number; truncated: boolean } | null
  >();
  if (counts.status === "ready") {
    for (const r of counts.data) {
      byProject.set(
        r.projectId,
        r.status === "ok" && r.count
          ? {
              needsYou: r.count.needsYou,
              truncated: r.count.truncated === true,
            }
          : null
      );
    }
  }
  const open = new Map<string, OpenSessionLite[]>();
  if (sessions.status === "ready") {
    for (const s of sessions.data) {
      if (!s.projectId || isTerminalSessionStatus(s.status)) continue;
      open.set(s.projectId, [...(open.get(s.projectId) ?? []), s]);
    }
  }

  const rows = projects.map((project): ProjectStandRow => {
    const waiting =
      counts.status === "ready" ? byProject.get(project.id) : undefined;
    if (waiting === null || counts.status === "failed") {
      return { project, state: { unreadable: true }, nextLine: null };
    }
    if (waiting && waiting.needsYou > 0) {
      return {
        project,
        state: { owedFromYou: waiting.needsYou },
        nextLine: lensCountDoorText(
          "blocking",
          waiting.needsYou,
          waiting.truncated
        ),
      };
    }
    if (sessions.status === "failed")
      return { project, state: { unreadable: true }, nextLine: null };
    const mine = open.get(project.id) ?? [];
    if (mine.length === 0)
      return { project, state: { idle: true }, nextLine: null };
    const state = projectAggregateInput({
      sessions: mine.map((s) =>
        pathRowSessionFact({
          status: s.status,
          ...(s.unitFacts !== undefined ? { unitFacts: s.unitFacts } : {}),
          ...(s.nextMove?.actor ? { nextMoveActor: s.nextMove.actor } : {}),
          ...(s.live !== undefined ? { live: s.live } : {}),
        })
      ),
      unreadable: false,
    });
    const lead = mine[0]!;
    return {
      project,
      state,
      nextLine: resolveSessionTitle(lead, { maxLength: 80 }) || null,
    };
  });

  const rank = (r: ProjectStandRow) =>
    (r.state.owedFromYou ?? 0) > 0
      ? 0
      : r.state.running
        ? 1
        : r.state.unreadable
          ? 3
          : 2;
  return rows
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        rank(a.r) - rank(b.r) ||
        (b.r.state.owedFromYou ?? 0) - (a.r.state.owedFromYou ?? 0) ||
        a.i - b.i
    )
    .map(({ r }) => r);
}
