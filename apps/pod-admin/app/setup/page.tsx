/**
 * /setup — first-admin bootstrap surface.
 *
 * Server component. Probes GET /api/hub/setup/status over the internal
 * pod URL. If the pod already has an admin (`needsSetup: false`), redirect
 * straight to /login — this page is only for fresh pods.
 *
 * Renders <SetupForm /> when setup is still required.
 */

import { redirect } from "next/navigation";
import { SetupForm } from "./SetupForm";

export const dynamic = "force-dynamic";

const INTERNAL_POD_URL = process.env.POD_URL ?? "http://localhost:4000";

interface SetupStatus {
  needsSetup: boolean;
  hasAdmin: boolean;
}

async function fetchSetupStatus(): Promise<SetupStatus | null> {
  try {
    const res = await fetch(
      `${INTERNAL_POD_URL.replace(/\/$/, "")}/api/hub/setup/status`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    return (await res.json()) as SetupStatus;
  } catch {
    return null;
  }
}

export default async function SetupPage() {
  const status = await fetchSetupStatus();

  // Pod already bootstrapped — nothing to do here.
  if (status && !status.needsSetup) {
    redirect("/login");
  }

  return <SetupForm />;
}
