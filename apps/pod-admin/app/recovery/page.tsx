/**
 * /recovery — "Can't sign in?" for this pod.
 *
 * Kratos' `selfservice.flows.recovery.ui_url` points here (generate_kratos_config
 * in `synap`), so a recovery flow id arrives as `?flow=`. A redeemed recovery
 * code arrives as `?flow=<id>#code=<one-time code>` (the fragment never reaches
 * this server). Without a flow, the page is the hub: the doors that work on
 * THIS pod. Public (exempt in proxy.ts) — the reader is signed out by design.
 */

import { RecoveryView } from "./RecoveryView";

export const dynamic = "force-dynamic";

interface RecoveryPageProps {
  searchParams: Promise<{ flow?: string }>;
}

export default async function RecoveryPage({ searchParams }: RecoveryPageProps) {
  const sp = await searchParams;
  return <RecoveryView initialFlowId={sp.flow ?? null} />;
}
