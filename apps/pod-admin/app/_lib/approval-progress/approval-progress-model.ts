/**
 * What a LARGE approval says while it applies in the background — pure, so the
 * toast and the review's decision bar read ONE derivation.
 *
 * The pod applies a composite proposal of 100+ operations in a background job
 * (`services/proposals/approval-runs.ts` in @synap/api) and reports progress on
 * `proposals.approvalProgress`. This turns that run into a mark (tone + busy),
 * a title carrying the real numbers, one detail line, and the door out.
 *
 * A failed READ of progress is its own state (`progressUnavailable`), never
 * "done" and never empty: the apply may still be running.
 */

import type { ExitTarget } from "../../../lib/open-in";

/** `proposals.approvalProgress` — the fields this model reads. */
export interface ApprovalRun {
  runId: string;
  proposalId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "stalled";
  phase: "entities" | "relations" | "finishing" | null;
  total: number;
  done: number;
  created: number;
  linked: number;
  failed: number;
  error: string | null;
  primaryId: string | null;
  sessionId: string | null;
  relationsFailed: number;
}

export type ApprovalTone = "default" | "success" | "danger" | "warning";

export interface ApprovalProgressCopy {
  tone: ApprovalTone;
  /** Still applying — the toast stays, the decision bar shows it instead of the verbs. */
  busy: boolean;
  title: string;
  /** One line under the title; null when there is nothing beyond it. */
  detail: string | null;
  /** 0–100, for a progress bar; null before anything is counted. */
  percent: number | null;
  /** Where "see what was created" goes, once it succeeded. */
  door: ExitTarget | null;
  /** The person can approve again to finish what is left. */
  resumable: boolean;
}

const n = (value: number) => value.toLocaleString("en-US");

/** Is the run still applying (poll it, keep the toast)? */
export function isApplying(run: ApprovalRun | null | undefined): boolean {
  return run?.state === "queued" || run?.state === "running";
}

/** "1,180 created · 52 already there · 8 failed" — zero parts omitted. */
export function countsLine(run: ApprovalRun): string | null {
  const parts = [
    run.created > 0 ? `${n(run.created)} created` : null,
    run.linked > 0 ? `${n(run.linked)} already there` : null,
    run.failed > 0 ? `${n(run.failed)} failed` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The door to what was created: the session the proposal belongs to (an
 * import's run room lists everything it produced), else the first record,
 * else the proposal itself.
 */
export function approvalDoor(run: ApprovalRun): ExitTarget {
  if (run.sessionId)
    return { kind: "object", objectKind: "session", id: run.sessionId };
  if (run.primaryId)
    return { kind: "object", objectKind: "entity", id: run.primaryId };
  return { kind: "object", objectKind: "proposal", id: run.proposalId };
}

function percentOf(run: ApprovalRun): number | null {
  if (run.total <= 0) return null;
  return Math.min(100, Math.round((run.done / run.total) * 100));
}

export function approvalProgressCopy(run: ApprovalRun): ApprovalProgressCopy {
  const counts = countsLine(run);
  switch (run.state) {
    case "queued":
      return {
        tone: "default",
        busy: true,
        title: `Waiting to start: ${n(run.total)} changes`,
        detail: "Another large approval is ahead of it.",
        percent: null,
        door: null,
        resumable: false,
      };
    case "running":
      return {
        tone: "default",
        busy: true,
        title:
          run.phase === "finishing"
            ? `Finishing up: ${n(run.done)} of ${n(run.total)}`
            : `Creating records: ${n(run.done)} of ${n(run.total)}`,
        detail: counts,
        percent: percentOf(run),
        door: null,
        resumable: false,
      };
    case "succeeded": {
      const relationsNote =
        run.relationsFailed > 0
          ? `${n(run.relationsFailed)} connections did not land`
          : null;
      return {
        tone: run.failed > 0 || run.relationsFailed > 0 ? "warning" : "success",
        busy: false,
        title: `Approved: ${n(run.total)} changes applied`,
        detail: [counts, relationsNote].filter(Boolean).join(" · ") || null,
        percent: 100,
        door: approvalDoor(run),
        resumable: false,
      };
    }
    case "failed":
    case "stalled":
      return {
        tone: "danger",
        busy: false,
        title: `Stopped at ${n(run.done)} of ${n(run.total)}`,
        detail:
          run.error ??
          "The approval stopped before it finished. What was created is kept.",
        percent: percentOf(run),
        door: null,
        resumable: true,
      };
  }
}

/** A failed read of progress: the apply may still be running. */
export const progressUnavailable: ApprovalProgressCopy = {
  tone: "warning",
  busy: true,
  title: "Can't read the approval's progress",
  detail: "It may still be applying. Retry to check again.",
  percent: null,
  door: null,
  resumable: false,
};
