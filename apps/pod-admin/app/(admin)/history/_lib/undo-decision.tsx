"use client";

/**
 * Undo on a decided request: `proposals.revert` with `reopen`, so the change
 * is taken back and the request waits for the person again. The receipt says
 * what the pod ANSWERED (feedback §1): undone, partly (some of it changed
 * since and was kept), or nothing, and that anything already sent stays sent.
 */

import { Button, addToast } from "@heroui/react";
import { useT } from "../../../../lib/i18n/locale-provider";
import { trpc } from "../../../../lib/trpc";
import { en, fr } from "./copy";
import { undoOutcome } from "./history-rows";

const CATALOGS = { en, fr };

export function UndoDecision({ proposalId }: { proposalId: string }) {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const revert = trpc.proposals.revert.useMutation({
    onSuccess: (answer) => {
      const outcome = undoOutcome(answer);
      addToast({
        title: t(`undo.${outcome}`),
        description: [
          t(`undo.${outcome}Hint`),
          answer.permanent ? t("undo.permanentHint") : null,
        ]
          .filter(Boolean)
          .join(" "),
        color: outcome === "done" ? "success" : "warning",
      });
    },
    onError: () => {
      addToast({
        title: t("undo.failed"),
        description: t("undo.failedHint"),
        color: "danger",
      });
    },
    onSettled: () => {
      void utils.proposals.invalidate();
      void utils.signals.invalidate();
    },
  });
  return (
    <Button
      size="sm"
      variant="flat"
      isLoading={revert.isPending}
      onPress={() => revert.mutate({ proposalId, reopen: true })}
    >
      {t("undo")}
    </Button>
  );
}
