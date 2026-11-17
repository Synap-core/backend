"use client";

/**
 * "Can't be undone", disclosed when it matters (founder, 17 Nov 2026, on a
 * phone: text appears "only when needed, or when a user does an action").
 * The decision bar draws no undo chip any more: on a change approving cannot
 * take back, the first press on Approve turns the verbs into a NAMED confirm
 * in place, "<verb> · can't be undone" with Cancel focused beside it, and the
 * mark's one sentence under them (feedback-and-forms §3: irreversible → a
 * named confirm, never "Are you sure?", never Yes / No). A reversible change
 * approves in one press, as before; its receipt offers Undo.
 */

import { Button } from "@heroui/react";
import { TriangleAlert } from "lucide-react";
import { proposalPageT } from "./copy";
import type { ReviewMark } from "./proposal-review-model";

/** What a press on Approve does: approve now, or ask once more (irreversible). */
export function approvePressAct(undo: ReviewMark | null): "approve" | "confirm" {
  return undo ? "confirm" : "approve";
}

export function ApproveConfirm({
  verb,
  undo,
  loading,
  disabled,
  onConfirm,
  onCancel,
}: {
  /** The verb as the button said it ("Approve", "Resume"). */
  verb: string;
  /** The undo mark: its sentence says why it cannot be taken back. */
  undo: ReviewMark;
  loading: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = proposalPageT();
  return (
    <div data-approve-confirm="" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          color="success"
          className="min-h-11"
          startContent={<TriangleAlert aria-hidden size={16} />}
          isLoading={loading}
          isDisabled={disabled}
          onPress={onConfirm}
        >
          {t("decide.confirmIrreversible", { verb })}
        </Button>
        <Button
          variant="bordered"
          className="min-h-11"
          // Cancel holds the focus: Enter never confirms by accident.
          autoFocus
          isDisabled={loading}
          onPress={onCancel}
          data-approve-cancel=""
        >
          {t("decide.confirmCancel")}
        </Button>
      </div>
      <p className="text-[12.5px] text-foreground/80">{undo.sentence}</p>
    </div>
  );
}
