/**
 * /start/defaults — the pod's notable defaults, chosen in one go (founder,
 * 5 Nov 2026, session b064a220), right after the work question.
 *
 * Server component. Asks the pod where this person is
 * (`onboarding.startState`): a FAILED read lands on Home with the failure
 * shown, a finished journey goes Home, and the work question comes first
 * (`stepPageDestination`). The switches read and write each setting through
 * its own door (`DefaultsStepForm`).
 *
 * Admin-tier (the default for an unlisted path, `lib/route-policy.ts`).
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { callPodQuery } from "../../../lib/pod-trpc";
import { podHostOf } from "../_lib/pod-host";
import { StartIsland } from "../_lib/start-island";
import { stepPageDestination, type StartState } from "../_lib/start-model";
import { DefaultsStepForm } from "./DefaultsStepForm";

export const dynamic = "force-dynamic";

export default async function StartDefaultsPage() {
  const h = await headers();
  const read = await callPodQuery<StartState>(
    "onboarding.startState",
    undefined,
    h
  );
  const destination = stepPageDestination(read);
  if (destination.kind === "redirect") redirect(destination.href);

  return (
    <StartIsland
      step="start:defaults"
      podHost={podHostOf(h)}
      identity={h.get("x-pod-admin-email") ?? undefined}
    >
      <DefaultsStepForm />
    </StartIsland>
  );
}
