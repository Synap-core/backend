/**
 * Is this request a Synap app's DEVICE session (join plan target A)?
 *
 * A device access token (`synap_pd_…`) lives 1 h and is the person on the app
 * API. A door that creates, rotates, widens or approves a CREDENTIAL — an API
 * key, a grant, a computer, an integration, an OAuth or MCP connection, an
 * agent's or a secret's grant — must refuse it, or a leaked token becomes a
 * long-lived key. Those acts happen on the pod's console, in a Kratos session.
 *
 * The kind is read from `ctx.sessionKind` (set ONLY by `createContext`, from
 * what `middleware/app-session.ts` resolved from the device row) and from the
 * device the session itself names. A Kratos session, or a request with no
 * person session (a key on the Hub tRPC door, whose own rules apply), passes.
 *
 * Doors: tRPC `refuseDeviceSession` / `credentialProcedure` (trpc.ts); a
 * proposal executor's `widensCredential` (execution-registry.ts); the
 * privileged approval floor (apply-approval.ts); the consent decision
 * (oauth/consent.ts). Tripwire: `credential-doors-refuse-device-session`.
 */
import { TRPCError } from "@trpc/server";

export const DEVICE_SESSION_REFUSED =
  "Sign in on your pod's console to create or change keys, computers and connections.";

export interface SessionKindCarrier {
  session?: { device?: unknown } | null;
  sessionKind?: string | null;
}

export function isDeviceSession(ctx: SessionKindCarrier | null | undefined) {
  return Boolean(
    ctx && (ctx.sessionKind === "person_device" || ctx.session?.device)
  );
}

/** FORBIDDEN for a device session; a no-op for anything else. */
export function assertNotDeviceSession(
  ctx: SessionKindCarrier | null | undefined
): void {
  if (isDeviceSession(ctx)) {
    throw new TRPCError({ code: "FORBIDDEN", message: DEVICE_SESSION_REFUSED });
  }
}
