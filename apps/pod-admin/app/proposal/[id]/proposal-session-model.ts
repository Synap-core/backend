/**
 * The session a proposal came from, as the review shows it — pure, so every
 * state is tested apart from the markup (`ProposalSessionContext.tsx`).
 *
 * Founder, 2026-10-26: reviewing ~50 proposals from a Glance overlay, he could
 * not see WHAT a change was for without leaving the page — the session's
 * purpose sat behind its provenance chip. So, under that chip: its goal, how
 * far its criteria are met, its track and project (doors), and how much more
 * from it still waits for this reader (a door to Review, filtered to it).
 * And, after a decision on the `/proposal` page, what to do next.
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
import {
  criteriaVerdictMark,
  type SessionVerdictLike,
} from "../../_lib/object/session-status";
import type { TrpcErrorLike } from "../../_lib/object/load-failure";
import {
  reviewRowMembers,
  type ReviewRow,
} from "../../(admin)/review/_lib/review-rows";

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
 * yours" — `absent`, never a failure to show; UNAUTHORIZED is `loading`: the
 * caller's `useReauthOnUnauthorized` is taking the reader to sign in, and a
 * "couldn't be read" they cannot act on would only flash before it; anything
 * else is `failed`.
 */
export function readOf<T>(q: QueryLike<T>, enabled = true): Read<T> {
  if (!enabled) return { state: "absent" };
  if (q.error) {
    const code = (q.error as TrpcErrorLike)?.data?.code;
    if (code === "UNAUTHORIZED") return { state: "loading" };
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
      { status: "ok"; verdict: SessionVerdictLike } | { status: "unavailable" };
    project:
      | { status: "ok"; project: { id: string; name: string } | null }
      | { status: "unavailable" };
  };
}

export type ProjectChip =
  { kind: "named"; id: string; name: string } | { kind: "unreadable" };

export interface SessionContext {
  /** The goal — null when the session's chip already IS the goal. */
  goal: string | null;
  /**
   * The ONE verdict mark (`criteriaVerdictMark`); null when the session
   * declares no criteria; "unreadable" when its evaluation read failed.
   */
  criteria: ReturnType<typeof criteriaVerdictMark> | "unreadable";
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

export function sessionContext(s: SessionReadLike): SessionContext {
  const { evaluation, project } = s.continuation;
  return {
    goal: sessionGoalLine(s),
    criteria:
      evaluation.status === "ok"
        ? criteriaVerdictMark(evaluation.verdict)
        : "unreadable",
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

/** Is this row only `proposalId` (a cluster holding it AND others still waits)? */
function isOnly(row: ReviewRow, proposalId: string): boolean {
  return row.count <= 1 && reviewRowMembers(row).includes(proposalId);
}

/**
 * The OTHER Review rows — the rows Review lists (narrowed to a session, or
 * not), less the one that is only this proposal. Counted in Review's unit,
 * the row, so the number here and Review's own "All" can never disagree
 * (ui-composition §11).
 */
export function othersWaiting(
  rows: readonly ReviewRow[],
  proposalId: string
): number {
  return rows.filter((r) => !isOnly(r, proposalId)).length;
}

/**
 * "4 more waiting" (Review's rows, so a cluster or an agent's question is one
 * each — the words name no unit). Null when none waits; a capped read says so.
 */
export function waitingLabel(count: number, capped: boolean): string | null {
  if (count <= 0) return null;
  return `${capped ? `${count}+` : count} more waiting`;
}

/** Review, filtered to one session (`?session=`, `review-page.tsx`). */
export function sessionReviewHref(sessionId: string): string {
  return navHref("review", { session: sessionId });
}

/**
 * Is the reader on Review already narrowed to this session? Then "N more
 * waiting" would be a link to the page they are on — it reloads it and drops
 * the open decision (`?focus=`) — so the strip leaves it out.
 */
export function onSessionReview(
  pathname: string | null,
  sessionParam: string | null,
  sessionId: string
): boolean {
  return pathname === navHref("review") && sessionParam === sessionId;
}

// ─── After the decision ─────────────────────────────────────────────────────

/**
 * Does the `/proposal` page offer what is next? Once the reader decided HERE
 * — a large approval still reads `pending` while it applies in the
 * background, and they are done with it all the same — or when they opened
 * one already decided. (The review draws it only under an outcome or a
 * running apply, never beside verbs still owed: `ProposalReviewBody`.)
 */
export function afterDecisionShown(
  decidedHere: boolean,
  actionable: boolean
): boolean {
  return decidedHere || !actionable;
}

/**
 * What the `/proposal` page offers once this proposal is decided, read off
 * Review's rows in Review's ONE order (newest first):
 *   `next`   — the first proposal row other than this one (a cluster whose
 *              sample is this proposal offers another member);
 *   `review` — no proposal left, but other rows still wait (an agent's
 *              question, a session to review…): a door to Review with their
 *              count, never a calm "done" over 100 open questions;
 *   `done`   — nothing else waits at all.
 */
export type AfterDecision =
  | { kind: "next"; proposalId: string; title: string }
  | { kind: "review"; count: number; capped: boolean }
  | { kind: "done" };

export function afterDecision(
  rows: readonly ReviewRow[],
  proposalId: string,
  capped: boolean
): AfterDecision {
  for (const r of rows) {
    if (r.detail?.kind !== "proposal") continue;
    const next =
      r.detail.proposalId !== proposalId
        ? r.detail.proposalId
        : reviewRowMembers(r).find((id) => id !== proposalId);
    if (next) return { kind: "next", proposalId: next, title: r.title };
  }
  const count = othersWaiting(rows, proposalId);
  return count > 0 ? { kind: "review", count, capped } : { kind: "done" };
}
