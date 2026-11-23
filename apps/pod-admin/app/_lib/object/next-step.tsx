"use client";

/**
 * An object's next step, drawn (`next-step-model.ts`): the one act it offers,
 * and the block an object page leads with. Turning on goes through the
 * object's governed status door (`automations.activate`, `playbooks.update`):
 * an agent's key proposes, and the toast says so.
 */

import { addToast, Button } from "@heroui/react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import { objectViewsT } from "./views/copy";
import type { NextStep, NextStepAct } from "./next-step-model";

function useTurnOn() {
  const utils = trpc.useUtils();
  const activate = trpc.automations.activate.useMutation();
  const update = trpc.playbooks.update.useMutation();
  async function turnOn(act: Extract<NextStepAct, { kind: "turn_on" }>) {
    const t = objectViewsT();
    try {
      const out =
        act.objectKind === "automation"
          ? await activate.mutateAsync({ id: act.id })
          : await update.mutateAsync({ id: act.id, status: "active" });
      const proposed = out.status === "proposed";
      addToast({
        title: proposed
          ? t("nextStep.proposed")
          : resolveActionLabel("turn_on", "past"),
        color: "default",
      });
      if (!proposed) {
        await Promise.all([
          utils.proposals.invalidate(),
          utils.automations.invalidate(),
          utils.playbooks.invalidate(),
        ]);
      }
    } catch (err) {
      addToast({
        title: t("nextStep.failed"),
        description: err instanceof Error ? err.message : undefined,
        color: "danger",
      });
    }
  }
  return { turnOn, pending: activate.isPending || update.isPending };
}

/** The ONE act of a next step: Turn on in place, any other step a door. */
export function NextStepAction({ step }: { step: NextStep }) {
  const { turnOn, pending } = useTurnOn();
  const act = step.act;
  if (act.kind === "door") {
    return <ExitLink exit={openIn(act.exit)} label={step.label} />;
  }
  return (
    <Button
      size="sm"
      radius="md"
      color="primary"
      variant="flat"
      isLoading={pending}
      onPress={() => void turnOn(act)}
    >
      {step.label}
    </Button>
  );
}

/**
 * What an object page leads with when the object needs the person: the step
 * and its one act. The page's header already carries the state's mark.
 */
export function NextStepBlock({ step }: { step: NextStep | null }) {
  if (!step) return null;
  const t = objectViewsT();
  return (
    <section
      aria-label={t("nextStep.title")}
      data-next-step=""
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-medium bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/10"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12px] font-medium text-foreground/65">
          {t("nextStep.title")}
        </span>
        {step.line && (
          <span className="text-[13px] text-foreground/85">{step.line}</span>
        )}
      </span>
      <span className="shrink-0">
        <NextStepAction step={step} />
      </span>
    </section>
  );
}
