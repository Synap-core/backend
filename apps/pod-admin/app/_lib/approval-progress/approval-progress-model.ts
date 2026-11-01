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

import { ambientCatalogLocale } from "@synap-core/types/i18n";
import type { ExitTarget } from "../../../lib/open-in";
import { approvalProgressT } from "./copy";

type T = ReturnType<typeof approvalProgressT>;

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
  /**
   * The records that already exist and stopped the run (the same-name gate).
   * Absent from a pod older than this field.
   */
  twins?: ApprovalRunTwin[] | null;
  /** Records a finished run left out: several existing ones shared the name. */
  skipped?: number;
}

/** An existing record a stopped run met. */
export interface ApprovalRunTwin {
  id: string;
  title: string | null;
  kind: string;
}

/** Did the run stop on records that already exist (the reviewer can answer)? */
export function stoppedOnTwins(
  run: ApprovalRun | null | undefined
): run is ApprovalRun & { twins: ApprovalRunTwin[] } {
  return (
    (run?.state === "failed" || run?.state === "stalled") &&
    Array.isArray(run.twins) &&
    run.twins.length > 0
  );
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

/** A count as the person's language writes it ("4,222" / "4 222"). */
const n = (value: number) =>
  value.toLocaleString(ambientCatalogLocale() === "fr" ? "fr-FR" : "en-US");

/** A number's two params: the formatted `n` to read, the raw `count` to pluralise. */
const num = (value: number) => ({ n: n(value), count: value });

/** Is the run still applying (poll it, keep the toast)? */
export function isApplying(run: ApprovalRun | null | undefined): boolean {
  return run?.state === "queued" || run?.state === "running";
}

/** "1,180 created · 52 already there · 8 failed" — zero parts omitted. */
export function countsLine(
  run: ApprovalRun,
  t: T = approvalProgressT()
): string | null {
  const parts = [
    run.created > 0 ? t("counts.created", num(run.created)) : null,
    run.linked > 0 ? t("counts.linked", num(run.linked)) : null,
    run.failed > 0 ? t("counts.failed", num(run.failed)) : null,
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

export function approvalProgressCopy(
  run: ApprovalRun,
  t: T = approvalProgressT()
): ApprovalProgressCopy {
  const counts = countsLine(run, t);
  const of = { done: n(run.done), total: n(run.total) };
  switch (run.state) {
    case "queued":
      return {
        tone: "default",
        busy: true,
        title: t("queued.title", num(run.total)),
        detail: t("queued.detail"),
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
            ? t("running.finishing", of)
            : t("running.creating", of),
        detail: counts,
        percent: percentOf(run),
        door: null,
        resumable: false,
      };
    case "succeeded": {
      const relationsNote =
        run.relationsFailed > 0
          ? t("done.relationsFailed", num(run.relationsFailed))
          : null;
      const skipped = run.skipped ?? 0;
      const skippedNote = skipped > 0 ? t("done.skipped", num(skipped)) : null;
      return {
        tone:
          run.failed > 0 || run.relationsFailed > 0 || skipped > 0
            ? "warning"
            : "success",
        busy: false,
        title: t("done.title", num(run.total)),
        detail:
          [counts, relationsNote, skippedNote].filter(Boolean).join(" · ") ||
          null,
        percent: 100,
        door: approvalDoor(run),
        resumable: false,
      };
    }
    case "failed":
    case "stalled":
      if (stoppedOnTwins(run)) {
        const name = run.twins[0]!.title;
        return {
          tone: "danger",
          busy: false,
          title: name
            ? t("stopped.twinNamed", { ...of, name })
            : t("stopped.twin", of),
          detail: t("stopped.twinDetail"),
          percent: percentOf(run),
          door: null,
          resumable: true,
        };
      }
      return {
        tone: "danger",
        busy: false,
        title: t("stopped.title", of),
        detail: run.error ?? t("stopped.detail"),
        percent: percentOf(run),
        door: null,
        resumable: true,
      };
  }
}

/** A failed read of progress: the apply may still be running. */
export function progressUnavailable(
  t: T = approvalProgressT()
): ApprovalProgressCopy {
  return {
    tone: "warning",
    busy: true,
    title: t("unavailable.title"),
    detail: t("unavailable.detail"),
    percent: null,
    door: null,
    resumable: false,
  };
}
