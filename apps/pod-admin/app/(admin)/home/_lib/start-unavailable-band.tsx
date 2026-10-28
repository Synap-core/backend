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

import { useRouter, useSearchParams } from "next/navigation";
import { ResourceRowError } from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";

export function StartUnavailableBand() {
  const params = useSearchParams();
  const router = useRouter();
  if (params.get("start") !== "unavailable") return null;
  return (
    <SectionCard title="Getting started" className="mb-4">
      <ResourceRowError
        message="Couldn't load your setup progress."
        onRetry={() => router.push("/")}
      />
    </SectionCard>
  );
}
