"use client";

/**
 * The ONE way pod admin moves a rule or a process on or off: its governed
 * status door (`automations.activate`, `playbooks.update`). An agent-owned
 * space proposes instead; the receipt then opens that request, and the
 * Turn on it came from becomes that door, so a second press files nothing.
 */

import Link from "next/link";
import { useState } from "react";
import { addToast, Button } from "@heroui/react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { useT } from "../../../lib/i18n/locale-provider";
import { CATALOGS } from "../../(admin)/processes/_lib/copy";
import { showReceipt } from "../receipt/decision-receipt-toast";
import { objectViewsT } from "./views/copy";

type Target =
  | { kind: "automation"; id: string; to: "active" }
  | { kind: "playbook"; id: string; to: "active" | "paused" };

export function useProcessStatus() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const activate = trpc.automations.activate.useMutation();
  const update = trpc.playbooks.update.useMutation();
  const [filed, setFiled] = useState<Record<string, string>>({});

  async function set(target: Target) {
    try {
      const out =
        target.kind === "automation"
          ? await activate.mutateAsync({ id: target.id })
          : await update.mutateAsync({ id: target.id, status: target.to });
      if (out.status === "proposed" && "proposalId" in out) {
        setFiled((f) => ({ ...f, [target.id]: out.proposalId }));
        showReceipt({
          title: t("action.proposed"),
          tone: "default",
          undo: false,
          action: {
            label: resolveActionLabel("review", "imperative"),
            href: `/proposal/${encodeURIComponent(out.proposalId)}`,
          },
        });
        return;
      }
      addToast({
        title: resolveActionLabel(
          target.to === "paused" ? "pause" : "turn_on",
          "past"
        ),
        color: "default",
      });
      await Promise.all([
        utils.proposals.invalidate(),
        utils.automations.invalidate(),
        utils.playbooks.invalidate(),
      ]);
    } catch (err) {
      addToast({
        title: t("action.failed"),
        description: err instanceof Error ? err.message : undefined,
        color: "danger",
      });
    }
  }

  return {
    set,
    pending: activate.isPending || update.isPending,
    filedFor: (id: string): string | undefined => filed[id],
  };
}

/** Turn on, or, once it was sent for review, the door to that request. */
export function TurnOnButton({
  status,
  target,
  name,
}: {
  status: ReturnType<typeof useProcessStatus>;
  target: { kind: "automation" | "playbook"; id: string };
  /** The object's name, for a row among others (its accessible name). */
  name?: string;
}) {
  const filed = status.filedFor(target.id);
  const label = filed
    ? resolveActionLabel("review", "imperative")
    : resolveActionLabel("turn_on", "imperative");
  const ariaLabel = name
    ? objectViewsT()("nextStep.actOn", { act: label, name })
    : undefined;
  if (filed) {
    return (
      <Button
        as={Link}
        href={`/proposal/${encodeURIComponent(filed)}`}
        size="sm"
        variant="flat"
        radius="md"
        aria-label={ariaLabel}
      >
        {label}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="flat"
      radius="md"
      color="primary"
      isLoading={status.pending}
      aria-label={ariaLabel}
      onPress={() =>
        void status.set(
          target.kind === "automation"
            ? { kind: "automation", id: target.id, to: "active" }
            : { kind: "playbook", id: target.id, to: "active" }
        )
      }
    >
      {label}
    </Button>
  );
}
