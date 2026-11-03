"use client";

/**
 * Home's "Getting started" band in its FAILED state (plan v1 §1 "The gate";
 * canvas Home, "Failed startState").
 *
 * The root gate could not read `onboarding.startState`, so it opened Home
 * instead of guessing (`/home?start=unavailable`). The failure is shown here,
 * never a calm Home; "Try again" re-runs the gate at `/`. The band's other
 * states (progress, next steps, Continue setup) are slice B5's.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ResourceRowError } from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import {
  startBandStep,
  startStepNumber,
} from "../../../start/_lib/start-model";

export function StartUnavailableBand() {
  const params = useSearchParams();
  const router = useRouter();
  const param = params.get("start");
  const step = startBandStep(param);
  if (step) {
    // The journey is at a step that has no page yet: say where setup stands,
    // and keep the one real door (change the start) open.
    const { n, of } = startStepNumber(step);
    return (
      <SectionCard title="Getting started" className="mb-4">
        <div className="flex flex-col gap-1.5 px-3 py-4 text-[13px] text-foreground/80">
          <p>
            Your setup is saved at step {n} of {of}. The next steps are not in
            the console yet.
          </p>
          <Link
            href="/start?step=intent"
            className="text-primary underline-offset-2 hover:underline"
          >
            Change what Synap runs first
          </Link>
        </div>
      </SectionCard>
    );
  }
  if (param !== "unavailable") return null;
  return (
    <SectionCard title="Getting started" className="mb-4">
      <ResourceRowError
        message="Couldn't load your setup progress."
        onRetry={() => router.push("/")}
      />
    </SectionCard>
  );
}
