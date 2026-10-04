/**
 * /settings/security — how YOU sign in to this pod, and how you get back in.
 *
 * Kratos' `selfservice.flows.settings.ui_url` points here, so a completed
 * recovery lands with `?flow=<settings flow>` and a privileged session. Any
 * signed-in pod member may use it (self-service in proxy.ts): every action is
 * scoped to the caller's own account; only the Synap Cloud trust choice is
 * owner-only, and the pod re-checks that.
 */

import { headers } from "next/headers";
import { SecurityView } from "./SecurityView";

export const dynamic = "force-dynamic";

interface SecurityPageProps {
  searchParams: Promise<{ flow?: string }>;
}

export default async function SecurityPage({ searchParams }: SecurityPageProps) {
  const sp = await searchParams;
  const email = (await headers()).get("x-pod-admin-email");
  return <SecurityView initialFlowId={sp.flow ?? null} email={email || null} />;
}
