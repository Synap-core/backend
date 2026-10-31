"use client";

/**
 * Draws a decision's receipt (`decision-receipt.ts`) on the one toast bar,
 * with Undo for `UNDO_WINDOW_MS` when the receipt offers it. A failure never
 * folds by itself: it waits until the person closes it.
 *
 * Undo of an approve is `proposals.revert` with `reopen` (the change is taken
 * back and the request waits again); Undo of a reject is `proposals.reopen`.
 * Each Undo's own answer gets its receipt. The toast is drawn inside the tRPC
 * provider (`app/providers.tsx`), so the Undo button reads the pod itself.
 */

import { Button, addToast, closeToast } from "@heroui/react";
import { useState } from "react";
import { trpc } from "../../../lib/trpc";
import { receiptT } from "./copy";
import {
  UNDO_WINDOW_MS,
  undoFailureReceipt,
  undoReceipt,
  type DecisionError,
  type DecisionVerb,
  type Receipt,
} from "./decision-receipt";

const COLOR: Record<Receipt["tone"], "success" | "default" | "danger"> = {
  success: "success",
  default: "default",
  danger: "danger",
};

/** Show a receipt that offers no Undo. */
export function showReceipt(receipt: Receipt): void {
  addToast({
    title: receipt.title,
    ...(receipt.description ? { description: receipt.description } : {}),
    color: COLOR[receipt.tone],
    ...(receipt.tone === "danger" ? { timeout: 0 } : {}),
  });
}

/**
 * Show a decision's receipt. With `receipt.undo`, the toast carries Undo for
 * `UNDO_WINDOW_MS` (paused while the pointer is on it). Once the pod answered
 * the Undo, the proposal and signal reads are refreshed, so every page that
 * shows the request draws it again.
 */
export function showDecisionReceipt(
  receipt: Receipt,
  undo?: { proposalId: string; verb: DecisionVerb }
): void {
  if (!receipt.undo || !undo) {
    showReceipt(receipt);
    return;
  }
  const holder: { key: string | null } = { key: null };
  holder.key = addToast({
    title: receipt.title,
    ...(receipt.description ? { description: receipt.description } : {}),
    color: COLOR[receipt.tone],
    timeout: UNDO_WINDOW_MS,
    endContent: (
      <UndoDecisionButton
        proposalId={undo.proposalId}
        verb={undo.verb}
        onAnswered={() => {
          if (holder.key) closeToast(holder.key);
        }}
      />
    ),
  });
}

/**
 * Undo one decision, then show what the pod answered (`undoReceipt`) and
 * refresh the proposal and signal reads. The one Undo door: the receipt's
 * Undo button and any row that offers Undo later (Historique) call it.
 *
 *   approve → `proposals.revert({ proposalId, reopen: true })`: the change is
 *             taken back and the request waits for a decision again;
 *   reject  → `proposals.reopen({ proposalId })`.
 */
export function useUndoDecision(): {
  undo: (proposalId: string, verb: DecisionVerb) => Promise<void>;
  pending: boolean;
} {
  const utils = trpc.useUtils();
  const revert = trpc.proposals.revert.useMutation();
  const reopen = trpc.proposals.reopen.useMutation();
  const undo = async (proposalId: string, verb: DecisionVerb) => {
    try {
      const answer =
        verb === "approve"
          ? await revert.mutateAsync({ proposalId, reopen: true })
          : await reopen.mutateAsync({ proposalId });
      showReceipt(undoReceipt(answer));
    } catch (err) {
      showReceipt(undoFailureReceipt(err as DecisionError));
    } finally {
      void utils.proposals.invalidate();
      void utils.signals.invalidate();
    }
  };
  return { undo, pending: revert.isPending || reopen.isPending };
}

/**
 * The Undo button: the receipt's, and a decided row's (Historique). It calls
 * `useUndoDecision`, so the pod's answer gets its own receipt.
 */
export function UndoDecisionButton({
  proposalId,
  verb,
  onAnswered,
}: {
  proposalId: string;
  verb: DecisionVerb;
  onAnswered?: () => void;
}) {
  const { undo } = useUndoDecision();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    await undo(proposalId, verb);
    setBusy(false);
    onAnswered?.();
  };

  return (
    <Button
      size="sm"
      variant="flat"
      radius="md"
      isLoading={busy}
      onPress={() => void run()}
    >
      {receiptT()("undo")}
    </Button>
  );
}
