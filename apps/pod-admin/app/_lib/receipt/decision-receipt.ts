/**
 * A decision's receipt: what the pod ANSWERED an approve, a reject or the
 * Undo of one, in a person's words (rule feedback-and-forms §1, §3, §4).
 *
 * pod-admin cannot import synap-app's `@synap-core/headless/receipt`, and
 * `@synap-core/types` holds no write-outcome reader, so this is pod-admin's
 * ONE reader for a decision's answer. Pure: the toast that draws it is
 * `decision-receipt-toast.tsx`.
 *
 *   - The title is ours. The pod's own sentence goes in the body only when
 *     the refusal is TYPED (a tRPC code other than an internal error) and
 *     reads as a sentence (`readableError`); never a raw exception.
 *   - "Approved" is said only when the answer says it applied: a no-op
 *     (`effect.applied: "none"`) or an approve of an already-approved request
 *     says nothing changed, and `success: false` is a failure.
 *   - Undo is offered only for an applied decision the pod can take back: an
 *     approve whose request the pod marked `revertable`, or any reject
 *     (`proposals.reopen` puts it back). An Undo with nothing behind it would
 *     be a lie.
 */

import { readableError } from "../../../lib/format";
import { receiptT } from "./copy";

/** The Undo window (feedback-and-forms §3, `UNDO_WINDOW_MS` in synap-app). */
export const UNDO_WINDOW_MS = 8_000;

export type DecisionVerb = "approve" | "reject";

export type DecisionOutcome =
  | { state: "applied"; verb: DecisionVerb }
  | { state: "no_effect"; verb: DecisionVerb; already: boolean }
  | { state: "failed"; verb: DecisionVerb; detail?: string };

/** The part of `proposals.approve`'s answer a receipt reads. */
export interface ApproveAnswer {
  success?: boolean;
  alreadyApproved?: boolean;
  effect?: { applied: string } | null;
}

/** `proposals.approve`'s answer, as the person should hear it. */
export function readApproveAnswer(answer: ApproveAnswer): DecisionOutcome {
  if (answer.success !== true) return { state: "failed", verb: "approve" };
  if (answer.alreadyApproved) {
    return { state: "no_effect", verb: "approve", already: true };
  }
  if (answer.effect?.applied === "none") {
    return { state: "no_effect", verb: "approve", already: false };
  }
  return { state: "applied", verb: "approve" };
}

/** `proposals.reject`'s answer. */
export function readRejectAnswer(answer: {
  success?: boolean;
}): DecisionOutcome {
  return answer.success === true
    ? { state: "applied", verb: "reject" }
    : { state: "failed", verb: "reject" };
}

/** A thrown tRPC error, the shape the client hands an `onError`. */
export interface DecisionError {
  message?: string;
  data?: { code?: string | null } | null;
}

/**
 * The pod's sentence for a refusal, when it is safe to show: a typed refusal
 * (CONFLICT, FORBIDDEN, BAD_REQUEST…) whose message is one plain sentence.
 * An internal error's message is never shown.
 */
export function typedDetail(err: DecisionError): string | undefined {
  const code = err.data?.code;
  if (!code || code === "INTERNAL_SERVER_ERROR") return undefined;
  return readableError(err.message);
}

/** A decision that threw. */
export function decisionFailure(
  verb: DecisionVerb,
  err: DecisionError
): DecisionOutcome {
  const detail = typedDetail(err);
  return detail ? { state: "failed", verb, detail } : { state: "failed", verb };
}

export interface Receipt {
  title: string;
  description?: string;
  tone: "success" | "default" | "danger";
  /** Offer Undo for `UNDO_WINDOW_MS`. */
  undo: boolean;
}

/**
 * The receipt of one decision. `revertable` is the request's own flag
 * (`proposals.get` / `.list`): whether the pod can take its approval back.
 */
export function decisionReceipt(
  outcome: DecisionOutcome,
  { revertable }: { revertable?: boolean | null } = {}
): Receipt {
  const t = receiptT();
  switch (outcome.state) {
    case "applied": {
      const undo = outcome.verb === "reject" || revertable === true;
      return outcome.verb === "approve"
        ? {
            title: t("approve.applied"),
            ...(undo ? { description: t("approve.undoHint") } : {}),
            tone: "success",
            undo,
          }
        : {
            title: t("reject.applied"),
            description: t("reject.undoHint"),
            tone: "default",
            undo,
          };
    }
    case "no_effect":
      return {
        title: outcome.already ? t("approve.already") : t("approve.noEffect"),
        tone: "default",
        undo: false,
      };
    case "failed":
      return {
        title:
          outcome.verb === "approve" ? t("approve.failed") : t("reject.failed"),
        description: outcome.detail ?? t("failed.hint"),
        tone: "danger",
        undo: false,
      };
  }
}

/** The part of `proposals.revert` / `proposals.reopen`'s answer Undo reads. */
export interface UndoAnswer {
  success?: boolean;
  nothingReverted?: boolean;
  partialFailures?: readonly string[];
  skipped?: readonly unknown[];
  permanent?: unknown;
}

/** What the pod answered an Undo. */
export function undoReceipt(answer: UndoAnswer): Receipt {
  const t = receiptT();
  if (answer.nothingReverted) {
    return {
      title: t("undo.nothing"),
      description: t("undo.nothingHint"),
      tone: "default",
      undo: false,
    };
  }
  // `success: false` without `nothingReverted` is a partial revert: some of
  // it is still live (`proposals.revert`'s `stillLive`), the rest came back.
  const partly =
    answer.success === false ||
    (answer.partialFailures?.length ?? 0) > 0 ||
    (answer.skipped?.length ?? 0) > 0;
  const hint = partly ? t("undo.partlyHint") : t("undo.doneHint");
  return {
    title: partly ? t("undo.partly") : t("undo.done"),
    description: answer.permanent ? `${hint} ${t("undo.permanentHint")}` : hint,
    tone: partly ? "default" : "success",
    undo: false,
  };
}

/** An Undo that threw. */
export function undoFailureReceipt(err: DecisionError): Receipt {
  const t = receiptT();
  return {
    title: t("undo.failed"),
    description: typedDetail(err) ?? t("failed.hint"),
    tone: "danger",
    undo: false,
  };
}

/**
 * A batch reject's receipt, counted from the pod's answer (`rejected`), not
 * from the rows picked: a request decided meanwhile is not counted.
 */
export function batchRejectReceipt(
  picked: number,
  answer: { rejected: number }
): Receipt {
  const t = receiptT();
  const rejected = Math.max(0, Math.min(answer.rejected, picked));
  const left = picked - rejected;
  if (rejected === 0) {
    return {
      title: t("batchReject.none"),
      description: t("batchReject.notRejectedHint", { n: left }),
      tone: "default",
      undo: false,
    };
  }
  if (left === 0) {
    return {
      title: t("batchReject.all", { n: rejected }),
      tone: "default",
      undo: false,
    };
  }
  return {
    title: t("batchReject.some", { rejected, picked }),
    description: t("batchReject.notRejectedHint", { n: left }),
    tone: "default",
    undo: false,
  };
}

/** A batch decision that threw. */
export function batchFailureReceipt(
  verb: DecisionVerb,
  err: DecisionError
): Receipt {
  const t = receiptT();
  return {
    title:
      verb === "approve" ? t("batchApprove.failed") : t("batchReject.failed"),
    description: typedDetail(err) ?? t("failed.hint"),
    tone: "danger",
    undo: false,
  };
}
