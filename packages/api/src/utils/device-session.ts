/**
 * FRESH AUTHENTICATION at a credential door (join plan target A, step-up).
 *
 * A door that creates, rotates, widens or approves a CREDENTIAL — an API key,
 * a grant, a secret's grant, a computer, an app, an integration, an OAuth or
 * MCP connection, an agent's auto-approve rule — must not let a LEAKED Synap
 * app token become a long-lived key. It accepts:
 *   - a Kratos session (the console in a browser), as before; or
 *   - a Synap app's DEVICE session whose `auth_time` — when the person last
 *     REALLY authenticated for that device (a password, passkey or Cloud
 *     login at /authorize; copied from the consenting Kratos session, moved
 *     only by a step-up, never by a refresh) — is at most
 *     `STEP_UP_WINDOW_MS` old.
 * A stale device session gets FORBIDDEN with `reasonCode: STEP_UP_REQUIRED`
 * (`error.data.reasonCode` on the wire): the app re-confirms it is the person
 * (`/authorize` with `prompt=login`, its device's refresh token at /token) and
 * retries.
 *
 * The device session comes from the context (`ctx.sessionKind` and the
 * device `ctx.session` names, set only by `createContext` from what
 * `middleware/app-session.ts` resolved from the row) or, for a door deep in a
 * service with no context, from the request's async scope, which the same
 * gate opens (`runAsDeviceSession`). A request with no person session (a key
 * on the Hub doors, whose own rules apply) is not this check's business.
 *
 * Doors: tRPC `requireFreshAuthentication` / `credentialProcedure`
 * (trpc.ts); a proposal executor's `widensCredential` (execution-registry.ts);
 * the privileged approval floor (apply-approval.ts); the secret-grant writers.
 * Tripwire: `credential-doors-refuse-device-session`. The consent decision
 * refuses ANY device session (`isDeviceSession`): consent is a browser act.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { TRPCError } from "@trpc/server";

/** How recent a device's real authentication must be at a credential door. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** The machine-readable reason a stale device session is refused. */
export const STEP_UP_REQUIRED = "STEP_UP_REQUIRED";

export const STEP_UP_REQUIRED_MESSAGE =
  "Confirm it's you to change keys, computers, connections or secrets.";

export interface DeviceSessionFacts {
  id: string;
  authTime: Date | null;
}

export interface SessionKindCarrier {
  session?: { device?: { id?: string; authTime?: Date | null } } | null;
  sessionKind?: string | null;
}

const deviceScope = new AsyncLocalStorage<DeviceSessionFacts>();

/** Run `fn` as a request made with a Synap app's device token. */
export function runAsDeviceSession<T>(
  device: DeviceSessionFacts,
  fn: () => T
): T {
  return deviceScope.run(device, fn);
}

/** Is this request a Synap app's device session (by context, else scope)? */
export function isDeviceSession(ctx?: SessionKindCarrier | null): boolean {
  return Boolean(
    ctx?.sessionKind === "person_device" ||
    ctx?.session?.device ||
    deviceScope.getStore()
  );
}

/** The device facts of this request, or null for any other caller. */
function deviceOf(ctx?: SessionKindCarrier | null): DeviceSessionFacts | null {
  const fromCtx = ctx?.session?.device;
  if (fromCtx?.id) {
    return { id: fromCtx.id, authTime: fromCtx.authTime ?? null };
  }
  const fromScope = deviceScope.getStore();
  if (fromScope) return fromScope;
  // Marked a device session but naming no device: never fresh.
  if (ctx?.sessionKind === "person_device") return { id: "", authTime: null };
  return null;
}

/** Was this device's last real authentication within the step-up window? */
export function isFreshDevice(
  device: DeviceSessionFacts,
  now: number = Date.now()
): boolean {
  if (!device.authTime) return false;
  const age = now - device.authTime.getTime();
  return age >= 0 && age <= STEP_UP_WINDOW_MS;
}

/**
 * FORBIDDEN (`STEP_UP_REQUIRED`) for a device session that has not really
 * authenticated within the window; a no-op for a Kratos session or a key.
 */
export function assertFreshAuthentication(
  ctx?: SessionKindCarrier | null
): void {
  const device = deviceOf(ctx);
  if (!device || isFreshDevice(device)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: STEP_UP_REQUIRED_MESSAGE,
    cause: { reasonCode: STEP_UP_REQUIRED },
  });
}
