/**
 * The pod's own answer to "does it offer Synap Cloud sign-in?"
 * (`GET /api/federation/discovery`), read server-side by the pages that need
 * it: `/connect` (the approved issuer) and `/invite/[token]` (whether to show
 * "Continue with Synap Cloud"). `available` is false when Cloud is not set up,
 * its issuer is not approved, or the owner turned Cloud sign-in off.
 *
 * A failed read is `null`, never `available: false`: each caller decides what
 * a failure means for it (both hide the Cloud door, failing closed; the pod's
 * Kratos hooks refuse a Cloud sign-in it does not allow anyway).
 */
import { podCallerHeaders } from "./pod-caller-headers";

const INTERNAL_POD_URL = process.env.POD_URL ?? "http://localhost:4000";

export interface CloudSignInDiscovery {
  available: boolean;
  issuerUrl: string | null;
}

export async function readCloudSignIn(
  incoming: Headers
): Promise<CloudSignInDiscovery | null> {
  try {
    const res = await fetch(`${INTERNAL_POD_URL}/api/federation/discovery`, {
      headers: podCallerHeaders(incoming),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      cloudSignIn?: { available?: boolean; issuerUrl?: string | null };
    };
    if (!body.cloudSignIn) return null;
    return {
      available: body.cloudSignIn.available === true,
      issuerUrl: body.cloudSignIn.issuerUrl ?? null,
    };
  } catch {
    return null;
  }
}
