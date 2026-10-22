/**
 * FRESH AUTHENTICATION at a credential door (a step-up).
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
 * A Kratos session sent as `X-Session-Token` (`sessionKind: kratos_token`)
 * is held by an app the same way, so it meets the same rule with its own
 * clock: when a credential was last presented at this pod in that session
 * (`kratosCredentialTime`; a Kratos re-login with `refresh=true` moves it, a
 * federated one does not). Only a browser's cookie session is exempt.
 *
 * The session comes from the context (`ctx.sessionKind` and the
 * device `ctx.session` names, set only by `createContext` from what
 * `middleware/app-session.ts` resolved) or, for a door deep in a
 * service with no context, from the request's async scope, which the same
 * gate opens (`runAsDeviceSession` / `runAsKratosTokenSession`). A request
 * with no person session (a key on the Hub doors, whose own rules apply) is
 * not this check's business.
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
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

/** The machine-readable reason a stale device session is refused. */
export const STEP_UP_REQUIRED = "STEP_UP_REQUIRED";

export const STEP_UP_REQUIRED_MESSAGE =
  "Confirm it's you before changing who or what can reach this pod.";

export interface DeviceSessionFacts {
  id: string;
  authTime: Date | null;
}

export interface SessionKindCarrier {
  session?:
    | (KratosAuthenticationFacts & {
        id?: string;
        device?: { id?: string; authTime?: Date | null };
      })
    | null;
  sessionKind?: string | null;
}

/** A Kratos session the request sent as `X-Session-Token`. */
export const KRATOS_TOKEN_SESSION = "kratos_token";

interface ScopedSession extends DeviceSessionFacts {
  kind: "person_device" | typeof KRATOS_TOKEN_SESSION;
}

const sessionScope = new AsyncLocalStorage<ScopedSession>();

/** Run `fn` as a request made with a Synap app's device token. */
export function runAsDeviceSession<T>(
  device: DeviceSessionFacts,
  fn: () => T
): T {
  return sessionScope.run({ ...device, kind: "person_device" }, fn);
}

/** Run `fn` as a request made with a Kratos session token. */
export function runAsKratosTokenSession<T>(
  session: DeviceSessionFacts,
  fn: () => T
): T {
  return sessionScope.run({ ...session, kind: KRATOS_TOKEN_SESSION }, fn);
}

/**
 * Ways to authenticate a person can only complete by presenting a credential
 * AT this pod (Kratos `authentication_methods[].method`). A federated sign-in
 * (`oidc`: Synap Cloud or any other provider) is not one: the provider may
 * answer from its own session without asking anything, so it can never prove
 * the person is here now. Nor is an account recovery.
 */
const POD_CREDENTIAL_METHODS = new Set([
  "password",
  "webauthn",
  "passkey",
  "totp",
  "lookup_secret",
  "code",
]);

/** The part of a Kratos session that says how it was authenticated. */
export interface KratosAuthenticationFacts {
  authentication_methods?: Array<{
    method?: string | null;
    completed_at?: string | null;
  }> | null;
}

/**
 * When the person last presented a credential AT this pod in this Kratos
 * session (`POD_CREDENTIAL_METHODS`), or null: a session authenticated only
 * through a federated provider, or one that does not say, has no such time.
 * This is the step-up clock of a Kratos session; `authenticated_at` is not,
 * because a silent federated re-login moves it.
 */
export function kratosCredentialTime(
  session: KratosAuthenticationFacts | null | undefined
): Date | null {
  let latest: Date | null = null;
  for (const m of session?.authentication_methods ?? []) {
    if (!m?.method || !POD_CREDENTIAL_METHODS.has(m.method)) continue;
    const at = m.completed_at ? new Date(m.completed_at) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

/** Is this request a Synap app's device session (by context, else scope)? */
export function isDeviceSession(ctx?: SessionKindCarrier | null): boolean {
  return Boolean(
    ctx?.sessionKind === "person_device" ||
    ctx?.session?.device ||
    sessionScope.getStore()?.kind === "person_device"
  );
}

/**
 * The step-up clock of this request — a device, or a Kratos session held as
 * a token — or null for a caller no clock applies to (a browser cookie, a
 * key).
 */
function clockOf(ctx?: SessionKindCarrier | null): DeviceSessionFacts | null {
  const fromCtx = ctx?.session?.device;
  if (fromCtx?.id) {
    return { id: fromCtx.id, authTime: fromCtx.authTime ?? null };
  }
  if (ctx?.sessionKind === KRATOS_TOKEN_SESSION) {
    return {
      id: ctx.session?.id ?? "",
      authTime: kratosCredentialTime(ctx.session),
    };
  }
  const fromScope = sessionScope.getStore();
  if (fromScope) return { id: fromScope.id, authTime: fromScope.authTime };
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
 * FORBIDDEN (`STEP_UP_REQUIRED`) for a device or Kratos-token session that
 * has not really authenticated within the window; a no-op for a browser's
 * cookie session or a key.
 */
export function assertFreshAuthentication(
  ctx?: SessionKindCarrier | null
): void {
  const clock = clockOf(ctx);
  if (!clock || isFreshDevice(clock)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: STEP_UP_REQUIRED_MESSAGE,
    cause: { reasonCode: STEP_UP_REQUIRED },
  });
}
