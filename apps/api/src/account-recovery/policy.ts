/**
 * Who may change how an account signs in — founder decision R1 (2026-10-04):
 * Synap Cloud may SIGN IN by default; RECOVERY is opt-in by the owner.
 *
 * "Recovery" here means changing a sign-in method: a password, a passkey, the
 * account's email, or its recovery codes. A session proven by Synap Cloud
 * alone (Kratos `oidc` provider `cp`) may do that only when:
 *   - the owner set Cloud trust to `sign_in_recovery`, or
 *   - the account holds NO pod-held way in yet (no password, passkey or
 *     recovery codes). Most owners first arrive through Synap Cloud; refusing
 *     them their FIRST pod-held factor would leave them nothing to recover
 *     with, and grants Cloud nothing it does not already have.
 *
 * Pure — the Kratos settings hook (`webhooks/kratos-cloud-trust.ts`) and the
 * pod's own endpoints (`routers/account-recovery.ts`) share it, so the two
 * doors can never disagree.
 */

import type { CloudTrustMode } from "@synap-core/types/account-recovery";

/** Kratos v1.3.1 `session.authentication_methods[]` (session/session.go). */
export interface KratosAuthenticationMethod {
  method?: string;
  provider?: string;
  completed_at?: string;
}

export interface KratosSessionLike {
  active?: boolean;
  authenticated_at?: string;
  authentication_methods?: KratosAuthenticationMethod[] | null;
  identity?: { id?: string; traits?: { email?: string } } | null;
}

/**
 * Factors the POD holds (identity/credentials.go CredentialsType values). An
 * `oidc` method is the Cloud; anything not listed is treated as not pod-held.
 */
const POD_HELD_METHODS = new Set([
  "password",
  "passkey",
  "webauthn",
  "totp",
  "lookup_secret",
  "code",
  "code_recovery",
  "link_recovery",
]);

/**
 * True when nothing in this session was proven by a pod-held factor. A session
 * with no recorded methods is treated as Cloud-only: it cannot prove otherwise.
 */
export function sessionIsCloudOnly(session: KratosSessionLike): boolean {
  const methods = session.authentication_methods ?? [];
  return !methods.some((m) => POD_HELD_METHODS.has(m.method ?? ""));
}

/** Kratos' `selfservice.flows.settings.privileged_session_max_age` (synap: 15m). */
export const PRIVILEGED_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

export function sessionIsPrivileged(
  session: KratosSessionLike,
  now: Date,
  maxAgeMs: number = PRIVILEGED_SESSION_MAX_AGE_MS
): boolean {
  const at = session.authenticated_at
    ? Date.parse(session.authenticated_at)
    : NaN;
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= maxAgeMs;
}

export type CredentialChangeDecision =
  | { allow: true; via: "pod_factor" | "cloud_trusted" | "first_factor" }
  | { allow: false; reason: "cloud_session_not_allowed" };

export function decideCredentialChange(input: {
  trust: CloudTrustMode;
  cloudOnly: boolean;
  accountHasPodHeldFactor: boolean;
}): CredentialChangeDecision {
  if (!input.cloudOnly) return { allow: true, via: "pod_factor" };
  if (input.trust === "sign_in_recovery") {
    return { allow: true, via: "cloud_trusted" };
  }
  if (!input.accountHasPodHeldFactor) {
    return { allow: true, via: "first_factor" };
  }
  return { allow: false, reason: "cloud_session_not_allowed" };
}

/**
 * May this session READ a secret the pod holds for its owner (the restic
 * recovery kit, which opens every backup)? Same Cloud rule as a credential
 * change, minus the `first_factor` exception: handing a Cloud-only session
 * its first pod factor gives the Cloud nothing it did not have, but handing
 * it the kit would let the Control Plane read the backups it must never read.
 * With `sign_in_recovery` the owner already trusts the Cloud to take the
 * account over, so the kit adds nothing.
 */
export function decideOwnerSecretRead(input: {
  trust: CloudTrustMode;
  cloudOnly: boolean;
}): { allow: true } | { allow: false; reason: "cloud_session_not_allowed" } {
  if (!input.cloudOnly || input.trust === "sign_in_recovery") {
    return { allow: true };
  }
  return { allow: false, reason: "cloud_session_not_allowed" };
}
