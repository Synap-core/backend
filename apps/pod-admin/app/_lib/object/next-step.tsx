"use client";

/**
 * An object's next step, drawn (`next-step-model.ts`): its one act, and the
 * block an object page leads with.
 */

import Link from "next/link";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { StatusPill } from "../../(admin)/components/status-pill";
import { OpenInAppLink } from "./open-in-app-link";
import { TurnOnButton, useProcessStatus } from "./use-process-status";
import { objectViewsT } from "./views/copy";
import type { NextStep, NextStepAct } from "./next-step-model";

function TurnOnAct({
  act,
  name,
}: {
  act: Extract<NextStepAct, { kind: "turn_on" }>;
  name?: string;
}) {
  const status = useProcessStatus();
  return (
    <TurnOnButton
      status={status}
      target={{ kind: act.objectKind, id: act.id }}
      name={name}
    />
  );
}

/** The ONE act of a next step; `name` names the object in a list. */
export function NextStepAction({
  act,
  name,
}: {
  act: NextStepAct;
  name?: string;
}) {
  if (act.kind === "turn_on") return <TurnOnAct act={act} name={name} />;
  if (act.kind === "in_app") {
    return <OpenInAppLink type={act.objectKind} id={act.id} />;
  }
  const label = resolveActionLabel("review", "imperative");
  return (
    <Link
      href={`/proposal/${encodeURIComponent(act.proposalId)}`}
      aria-label={
        name
          ? objectViewsT()("nextStep.actOn", { act: label, name })
          : undefined
      }
      className="text-[13px] font-medium text-foreground underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground"
    >
      {label}
    </Link>
  );
}

/** What an object page leads with while the object needs the reader. */
export function NextStepBlock({ step }: { step: NextStep | null }) {
  if (!step) return null;
  const t = objectViewsT();
  return (
    <section
      aria-labelledby="next-step-title"
      data-next-step=""
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-medium bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/10"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          id="next-step-title"
          className="text-[12px] font-medium text-foreground/65"
        >
          {t("nextStep.title")}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <StatusPill kind={step.pill.kind} label={step.pill.label} />
          {step.line && (
            <span className="text-[13px] text-foreground/85">{step.line}</span>
          )}
        </span>
      </span>
      {step.act && (
        <span className="shrink-0">
          <NextStepAction act={step.act} />
        </span>
      )}
    </section>
  );
}
