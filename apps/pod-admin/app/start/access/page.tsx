/**
 * /start/access — two ways to confirm it's you, before the pod's defaults
 * (founder, 7 Nov 2026, session 539e519b; finding 020455d5). A pod starts in
 * `enforce`: an owner with one way in is locked out the day it fails.
 *
 * Server component. Asks the pod where this person is
 * (`onboarding.startState`): a FAILED read lands on Home with the failure
 * shown, a finished journey goes Home, and the work question comes first
 * (`stepPageDestination`). Each way is added through its own door
 * (`AccessStepForm`).
 *
 * Admin-tier (the default for an unlisted path, `lib/route-policy.ts`).
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { callPodQuery } from "../../../lib/pod-trpc";
import { podHostOf } from "../_lib/pod-host";
import { StartIsland } from "../_lib/start-island";
import { stepPageDestination, type StartState } from "../_lib/start-model";
import { AccessStepForm } from "./AccessStepForm";

export const dynamic = "force-dynamic";

export default async function StartAccessPage() {
  const h = await headers();
  const read = await callPodQuery<StartState>(
    "onboarding.startState",
    undefined,
    h
  );
  const destination = stepPageDestination(read);
  if (destination.kind === "redirect") redirect(destination.href);

  const email = h.get("x-pod-admin-email");
  return (
    <StartIsland
      step="start:access"
      podHost={podHostOf(h)}
      identity={email ?? undefined}
    >
      <AccessStepForm email={email || null} />
    </StartIsland>
  );
}
