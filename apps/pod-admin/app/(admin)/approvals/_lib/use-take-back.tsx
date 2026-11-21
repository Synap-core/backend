"use client";

/**
 * Taking an approval back, after a confirmation that says what changes: the
 * ONE way back for a row, on Approvals, a tool's page and an agent's page
 * (lane W3). `governanceRules.revoke` (the pod re-checks who may); a refusal
 * shows in the dialog in the pod's own words. Every read of the rows is
 * refreshed after, so the three pages never disagree.
 */

import { addToast } from "@heroui/react";
import { useState, type ReactNode } from "react";
import { humanizePrincipal } from "@synap-core/types/governance-rules";
import { trpc } from "../../../../lib/trpc";
import { readableError } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n/locale-provider";
import type { ApprovalRowLike } from "../../../../lib/governance-rules/approvals-model";
import { ConfirmModal } from "../../components/confirm-modal";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

export function useTakeBack<R extends ApprovalRowLike>(
  titleOf: (row: R) => string
): { ask: (row: R) => void; modal: ReactNode } {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const revoke = trpc.governanceRules.revoke.useMutation();
  const [pending, setPending] = useState<R | null>(null);
  const [actError, setActError] = useState<string | null>(null);

  async function confirmTakeBack() {
    if (!pending) return;
    setActError(null);
    try {
      await revoke.mutateAsync({ id: pending.id });
      addToast({
        title: t("takeBack.done", { what: titleOf(pending) }),
        color: "default",
      });
      setPending(null);
      await Promise.all([
        utils.governanceRules.listAll.invalidate(),
        utils.governanceRules.matrix.invalidate(),
        utils.governanceRules.actionModes.invalidate(),
      ]);
    } catch (err) {
      // The pod's refusal, as it said it: who may take a row back is its call.
      setActError(
        readableError(err instanceof Error ? err.message : null) ??
          t("takeBack.failed")
      );
    }
  }

  const modal = (
    <ConfirmModal
      isOpen={pending !== null}
      onClose={() => {
        if (revoke.isPending) return;
        setPending(null);
        setActError(null);
      }}
      onConfirm={() => void confirmTakeBack()}
      title={t("takeBack.title", { what: pending ? titleOf(pending) : "" })}
      consequence={
        pending?.verdict === "auto"
          ? t("takeBack.auto", { who: humanizePrincipal(pending) })
          : pending?.verdict === "deny"
            ? t("takeBack.deny", { who: humanizePrincipal(pending) })
            : pending
              ? t("takeBack.propose")
              : null
      }
      confirmLabel={t("takeBack.label")}
      confirmColor="warning"
      isPending={revoke.isPending}
    >
      {actError && <p className="text-[12.5px] text-status-down">{actError}</p>}
    </ConfirmModal>
  );

  return {
    ask: (row) => {
      setActError(null);
      setPending(row);
    },
    modal,
  };
}
