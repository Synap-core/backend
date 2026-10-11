/**
 * /device — approve a computer (MACHINE-IDENTITY-PLAN W3).
 *
 * The page `synap init` sends a person to: the terminal prints
 * `<pod-admin>/device` and a QR of `/device?code=XXXX-XXXX` (RFC 8628
 * `verification_uri[_complete]`). One decision approves the computer AND the
 * agents it will set up, or denies them ("This wasn't me").
 *
 * Auth: `proxy.ts` lists `/device` as self-service — any signed-in pod user may
 * connect their own computer; the pod re-checks the session (keys refused).
 * A signed-out visitor goes to `/login?return=/device?code=…` and comes back.
 */

import { headers } from "next/headers";
import { DeviceFlow } from "./DeviceFlow";

export const dynamic = "force-dynamic";

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const sp = await searchParams;
  const h = await headers();
  return (
    <DeviceFlow
      initialCode={sp.code?.trim() || null}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}
