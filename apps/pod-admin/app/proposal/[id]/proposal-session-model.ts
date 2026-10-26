/**
 * The session a proposal came from, as the review shows it — pure, so every
 * state is tested apart from the markup (`ProposalSessionContext.tsx`).
 *
 * Founder, 2026-10-26: reviewing ~50 proposals from a Glance overlay, he could
 * not see WHAT a change was for without leaving the page — the session's
 * purpose sat behind its provenance chip. So, under that chip: its goal, how
 * far its criteria are met, its track and project (doors), and how much more
 * from it still waits for this reader (a door to Review, filtered to it).
 * And, after a decision on the `/proposal` page, the next waiting proposal.
 *
 * Reads, each through its own door and floor:
 *   `focusSessions.get`  — goal, track id, criteria verdict, project (the
 *                          session READ floor `proposals.source` already
 *                          applied: a session the reader may not read never
 *                          reaches here);
 *   `tracks.get`         — the track's name (track visibility);
 *   `signals.list`       — needs-you, the population and ORDER Review reads
 *                          (`review-rows.ts`), session-scoped for the count,
 *                          pod-wide for "next".
 *
 * A read the reader may not make (NOT_FOUND / FORBIDDEN) is OMITTED; a read
 * that FAILED says so, with a retry — never folded into "nothing".
 */

import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { navHref } from "../../../lib/console-nav";
import { shortDescription } from "../../_lib/object/object-summaries";
import type { TrpcErrorLike } from "../../_lib/object/load-failure";
import type { ReviewRow } from "../../(admin)/review/_lib/review-rows";

// ─── One read, four states ──────────────────────────────────────────────────

export type Read<T> =
  | { state: "loading" }
  /** Not this reader's to see (or nothing to read): drawn as nothing. */
  | { state: "absent" }
  | { state: "failed" }
  | { state: "ok"; value: T };

/** The fields of a TanStack query the four states read. */
export interface QueryLike<T> {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
}

/**
 * A query as one of four states. `enabled: false` is `absent` (there was
 * nothing to read); NOT_FOUND / FORBIDDEN are the read floor saying "not
 * yours" — `absent`, never a failure to show; anything else is `failed`.
 */
export function readOf<T>(q: QueryLike<T>, enabled = true): Read<T> {
  if (!enabled) return { state: "absent" };
  if (q.error) {
    const code = (q.error as TrpcErrorLike)?.data?.code;
    return code === "NOT_FOUND" || code === "FORBIDDEN"
      ? { state: "absent" }
      : { state: "failed" };
  }
  if (q.data !== undefined) return { state: "ok", value: q.data };
  return q.isLoading ? { state: "loading" } : { state: "absent" };
}

// ─── The session itself ─────────────────────────────────────────────────────

/** The fields of a `focusSessions.get` result this reads (structural). */
export interface SessionReadLike {
  title?: string | null;
  goal?: string | null;
  trackId?: string | null;
  continuation: {
    evaluation:
      | {
          status: "ok";
          verdict: { passed: number; total: number; state: string };
        }
      | { status: "unavailable" };
    project:
      | { status: "ok"; project: { id: string; name: string } | null }
      | { status: "unavailable" };
  };
}

export type CriteriaMark =
  | {
      kind: "progress";
      label: string;
      /** passing → success, a failed required criterion → warning. */
      tone: "success" | "warning" | "default";
    }
  | { kind: "unreadable" };

export type ProjectChip =
  { kind: "named"; id: string; name: string } | { kind: "unreadable" };

export interface SessionContext {
  /** The goal, one line — null when the session's chip already IS the goal. */
  goal: string | null;
  /** Null when the session declares no criteria. */
  criteria: CriteriaMark | null;
  /** Null when the session serves no project (or one the reader can't see). */
  project: ProjectChip | null;
  trackId: string | null;
}

/**
 * The goal, unless the provenance chip already shows it: a session with no
 * title of its own is NAMED by its goal's first line (`resolveSessionTitle`),
 * and drawing it twice, one line apart, is noise.
 */
export function sessionGoalLine(s: {
  title?: string | null;
  goal?: string | null;
}): string | null {
  if (!resolveSessionTitle({ title: s.title })) return null;
  return shortDescription(s.goal);
}

/** "2 of 3 criteria met", toned by the pod's own verdict (`SessionVerdict`). */
export function criteriaMark(
  evaluation: SessionReadLike["continuation"]["evaluation"]
): CriteriaMark | null {
  if (evaluation.status !== "ok") return { kind: "unreadable" };
  const { passed, total, state } = evaluation.verdict;
  if (total === 0) return null;
  return {
    kind: "progress",
    label: `${passed} of ${total} ${total === 1 ? "criterion" : "criteria"} met`,
    tone:
      state === "passing"
        ? "success"
        : state === "failing"
          ? "warning"
          : "default",
  };
}

export function sessionContext(s: SessionReadLike): SessionContext {
  const project = s.continuation.project;
  return {
    goal: sessionGoalLine(s),
    criteria: criteriaMark(s.continuation.evaluation),
    project:
      project.status !== "ok"
        ? { kind: "unreadable" }
        : project.project
          ? { kind: "named", ...project.project }
          : null,
    trackId: s.trackId ?? null,
  };
}

// ─── What else waits ────────────────────────────────────────────────────────

/** The most rows one needs-you read returns (`signals.list` limit). */
export const WAITING_LIMIT = 100;

/** The proposal ids a Review row decides (its `ids` after the signal id). */
function memberIds(row: ReviewRow): string[] {
  return row.ids.slice(1);
}

/**
 * The OTHER Review rows of this session — the rows `/review?session=` lists,
 * less the one that is only this proposal (a cluster holding it AND others
 * still waits). Counted in Review's unit, the row, so the number here and
 * the filtered page's "All" can never disagree (ui-composition §11).
 */
export function othersWaiting(
  rows: readonly ReviewRow[],
  proposalId: string
): number {
  return rows.filter(
    (r) => !(r.count <= 1 && memberIds(r).includes(proposalId))
  ).length;
}

/** "4 more from this session wait for you"; null when none does. */
export function waitingLabel(count: number, capped: boolean): string | null {
  if (count <= 0) return null;
  const n = capped ? `${count}+` : String(count);
  return `${n} more from this session ${count === 1 && !capped ? "waits" : "wait"} for you`;
}

/** Review, filtered to one session (`?session=`, `review-page.tsx`). */
export function sessionReviewHref(sessionId: string): string {
  return navHref("review", { session: sessionId });
}

// ─── Next ───────────────────────────────────────────────────────────────────

export interface NextProposal {
  proposalId: string;
  title: string;
}

/**
 * The next proposal to decide: the FIRST proposal row Review lists (its one
 * order, newest first), other than this one — so a reviewer in an overlay
 * keeps going where Review would have sent them. A cluster whose sample is
 * this proposal offers another of its members.
 */
export function nextWaitingProposal(
  rows: readonly ReviewRow[],
  proposalId: string
): NextProposal | null {
  for (const r of rows) {
    if (r.detail?.kind !== "proposal") continue;
    const next =
      r.detail.proposalId !== proposalId
        ? r.detail.proposalId
        : memberIds(r).find((id) => id !== proposalId);
    if (next) return { proposalId: next, title: r.title };
  }
  return null;
}
