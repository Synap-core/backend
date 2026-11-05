/**
 * /start — the onboarding journey's entry (plan v1 §1 S1, "Resume").
 *
 * Server component. Asks the pod where this person is (`onboarding.startState`)
 * and reopens that step; renders S1 when the intent step is open, or when the
 * person came back to it (`?step=intent`). A FAILED read lands on Home with
 * the failure shown (the gate's rule): onboarding is never drawn on a guess.
 *
 * Admin-tier (the default for an unlisted path, `lib/route-policy.ts`):
 * members are not onboarded in v1.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { callPodQuery } from "../../lib/pod-trpc";
import { podHostOf } from "./_lib/pod-host";
import { StartIsland } from "./_lib/start-island";
import {
  intentModel,
  startPageDestination,
  START_UNAVAILABLE_HREF,
  type StartCard,
  type StartState,
} from "./_lib/start-model";
import { StartIntentForm } from "./StartIntentForm";

export const dynamic = "force-dynamic";

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const h = await headers();
  const { step } = await searchParams;
  const read = await callPodQuery<StartState>(
    "onboarding.startState",
    undefined,
    h
  );
  const destination = startPageDestination({
    read,
    backToIntent: step === "intent",
  });
  if (destination.kind === "redirect") redirect(destination.href);

  const { state } = destination;
  // The pod lists the starts with the state while the intent step is open;
  // a person who came BACK to it asks for them on their own.
  let starts: StartCard[] | undefined = state.starts;
  if (!starts) {
    const listed = await callPodQuery<StartCard[]>(
      "onboarding.listStarts",
      undefined,
      h
    );
    if (!listed.ok) redirect(START_UNAVAILABLE_HREF);
    starts = listed.data;
  }

  const model = intentModel({
    starts,
    cloud: state.cloud,
    recorded: state.journey?.progress?.values?.start?.intent,
  });

  return (
    <StartIsland
      step="start:intent"
      podHost={podHostOf(h)}
      identity={h.get("x-pod-admin-email") ?? undefined}
    >
      <StartIntentForm model={model} />
    </StartIsland>
  );
}
