import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { callPodQuery } from "../lib/pod-trpc";
import { CONSOLE_ROLE_HEADER, type ConsoleRole } from "../lib/route-policy";
import { rootDestination, type StartState } from "./start/_lib/start-model";

export const dynamic = "force-dynamic";

/**
 * Root → Home, or → `/start` when the pod says onboarding is due (plan v1
 * §1 "The gate"). The console shell never renders at `/` directly.
 *
 * Only a pod admin is asked about: the proxy has already resolved the role
 * (`x-pod-console-role`), and a member is never onboarded in v1. A FAILED
 * `startState` read lands on Home with the failure shown, never on a guess.
 */
export default async function RootPage() {
  const h = await headers();
  const role = h.get(CONSOLE_ROLE_HEADER) as ConsoleRole | null;
  const read =
    role === "admin"
      ? await callPodQuery<StartState>("onboarding.startState", undefined, h)
      : null;
  redirect(rootDestination({ role, read }));
}
