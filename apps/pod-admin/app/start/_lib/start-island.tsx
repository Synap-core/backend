"use client";

/**
 * The frame of every `/start` step: the receiver frame (pod + who is signed
 * in) at Island width, the 7-segment step trail, and the "where your data
 * lives" line (page-grammar Island; canvas S1-S7).
 */

import { CardBody } from "@heroui/react";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import type { StartStepId } from "@synap-core/types/onboarding/start";
import { HostName } from "../../_lib/host-name";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { startStepNumber } from "./start-model";

export function StartIsland({
  step,
  podHost,
  identity,
  children,
}: {
  step: StartStepId;
  podHost?: string;
  identity?: string;
  children: ReactNode;
}) {
  const { n, of } = startStepNumber(step);
  return (
    <ReceiverShell podHost={podHost} identity={identity} width="sm">
      <CardBody className="gap-4 p-5 sm:p-6">
        <div className="flex items-center gap-3 text-[12px] text-foreground/65">
          <span className="flex flex-1 gap-1" aria-hidden>
            {Array.from({ length: of }, (_, i) => (
              <i
                key={i}
                className={`h-1 flex-1 rounded-full ${
                  i < n - 1
                    ? "bg-primary/60"
                    : i === n - 1
                      ? "bg-primary"
                      : "bg-foreground/10"
                }`}
              />
            ))}
          </span>
          <span className="tabular">
            Step {n} of {of}
          </span>
        </div>

        {children}

        {podHost && (
          <p className="flex items-center gap-1.5 border-t border-foreground/10 pt-3 text-[12px] text-foreground/65">
            <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span>Everything stays on your pod ·</span>
            <HostName host={podHost} />
          </p>
        )}
      </CardBody>
    </ReceiverShell>
  );
}

/** Three skeleton cards in the step's frame (S1 "Loading"). */
export function StartIslandSkeleton({ step }: { step: StartStepId }) {
  return (
    <StartIsland step={step}>
      <div className="flex flex-col gap-2" aria-busy="true">
        <div className="h-5 w-3/4 rounded-md bg-foreground/10 shimmer-pulse" />
        <div className="h-3.5 w-11/12 rounded-md bg-foreground/[0.07] shimmer-pulse" />
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 rounded-lg bg-foreground/[0.06] shimmer-pulse"
          />
        ))}
      </div>
    </StartIsland>
  );
}
