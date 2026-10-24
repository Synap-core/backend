/**
 * /link-cloud — link your Synap Cloud account to this pod (join plan phase
 * 4, decision 2 of 2026-10-23). An Island page: the CP's claim-access hop
 * arrives here twice (`lib/link-cloud.ts`), and Settings › Security and the
 * invite page's Synap Cloud join start here.
 *
 * Any signed-in pod member may use it (self-service in `lib/route-policy.ts`):
 * the pod's identity-link door binds only the caller's own session. Synap
 * Cloud's address comes from this pod's own discovery, read server-side; when
 * the owner turned Synap Cloud off, the page says so and links nothing (the
 * door refuses anyway).
 */

import { headers } from "next/headers";
import { readCloudSignIn } from "../../lib/cloud-sign-in";
import { LinkCloud } from "./LinkCloud";

export const dynamic = "force-dynamic";

export default async function LinkCloudPage() {
  const incoming = await headers();
  const cloud = await readCloudSignIn(incoming);
  return (
    <LinkCloud
      cloud={cloud}
      email={incoming.get("x-pod-admin-email") || null}
    />
  );
}
