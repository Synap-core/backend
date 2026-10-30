"use client";

/**
 * Undo on a decided request, through the ONE Undo door
 * (`useUndoDecision`, `app/_lib/receipt`): the change is taken back
 * (`proposals.revert` with `reopen`) and the request waits for the person
 * again; the receipt says what the pod answered.
 */

import { Button } from "@heroui/react";
import { receiptT } from "../../../_lib/receipt/copy";
import { useUndoDecision } from "../../../_lib/receipt/decision-receipt-toast";

export function UndoDecision({ proposalId }: { proposalId: string }) {
  const { undo, pending } = useUndoDecision();
  return (
    <Button
      size="sm"
      variant="flat"
      isLoading={pending}
      onPress={() => void undo(proposalId, "approve")}
    >
      {receiptT()("undo")}
    </Button>
  );
}
