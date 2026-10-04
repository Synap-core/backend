/**
 * Pod account recovery — the wire contract every surface builds against
 * (pod-admin, Relay, the desktop app). The pod's `apps/api`
 * `routers/account-recovery.ts` is the ONE implementation; this module only
 * names its shapes, so a client and the pod can never disagree on a field.
 *
 * Endpoints (all under the pod's public API origin):
 *
 *   GET  /api/account-recovery/doors        unauthenticated → {@link RecoveryDoors}
 *   POST /api/account-recovery/redeem       unauthenticated, {@link RedeemRecoveryCodeRequest}
 *                                           → 200 {@link RedeemRecoveryCodeSuccess}
 *                                           | 401/429/503 {@link AccountRecoveryError}
 *   GET  /api/account-recovery/status       session → {@link AccountRecoveryStatus}
 *   POST /api/account-recovery/codes        session, privileged → {@link GeneratedRecoveryCodes}
 *   PUT  /api/account-recovery/cloud-trust  session, privileged, pod admin,
 *                                           {@link SetCloudTrustRequest} → {@link AccountRecoveryStatus}
 *
 * Pure + dependency-free — safe in browser, React Native, Node and Next.js.
 */

/**
 * What Synap Cloud (the Kratos `cp` OIDC provider) may do on this pod. Owner
 * set; founder decision R1 (2026-10-04): sign-in by default, recovery opt-in.
 *
 *   off              — "Continue with Synap Cloud" is refused at login.
 *   sign_in          — Cloud signs you in, but a Cloud-only session cannot
 *                      change a sign-in method or recovery codes.
 *   sign_in_recovery — Cloud signs you in AND can recover the account.
 */
export const CLOUD_TRUST_MODES = ["off", "sign_in", "sign_in_recovery"] as const;
export type CloudTrustMode = (typeof CLOUD_TRUST_MODES)[number];
export const DEFAULT_CLOUD_TRUST: CloudTrustMode = "sign_in";

export function isCloudTrustMode(value: unknown): value is CloudTrustMode {
  return (
    typeof value === "string" &&
    (CLOUD_TRUST_MODES as readonly string[]).includes(value)
  );
}

/**
 * The ONE label set for Cloud trust (pod-admin, Relay, the desktop app):
 * a short label and the consequence, in the order a picker shows them.
 */
export const CLOUD_TRUST_OPTIONS: ReadonlyArray<{
  mode: CloudTrustMode;
  label: string;
  detail: string;
}> = [
  {
    mode: "off",
    label: "Off",
    detail: "Synap Cloud can't sign anyone in to this pod.",
  },
  {
    mode: "sign_in",
    label: "Sign in",
    detail:
      "Synap Cloud signs you in. Changing a password or recovery codes needs this pod's own sign-in.",
  },
  {
    mode: "sign_in_recovery",
    label: "Sign in and recover",
    detail:
      "Synap Cloud can also recover accounts here. Whoever controls your Synap Cloud account can take over this one.",
  },
];

/** Ten codes per batch; regenerating replaces the whole batch. */
export const RECOVERY_CODE_COUNT = 10;
/** 16 Crockford base32 symbols = 80 bits of entropy per code. */
export const RECOVERY_CODE_LENGTH = 16;
/** Crockford base32: no I, L, O, U — read aloud and typed without confusion. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Canonical form of a typed code: upper-case, separators dropped, and the
 * Crockford look-alikes folded (I/L → 1, O → 0). Returns null for anything
 * that cannot be a code, so a client can refuse it before a round-trip.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const folded = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (folded.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of folded) {
    if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  }
  return folded;
}

/** Display form: `XXXX-XXXX-XXXX-XXXX`. */
export function formatRecoveryCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/** Which "Can't sign in?" doors work on THIS pod (unauthenticated read). */
export interface RecoveryDoors {
  /** At least one account on this pod holds unused recovery codes. */
  recoveryCode: boolean;
  /** The pod's mail courier is a real relay, so "Email me a code" delivers. */
  email: boolean;
  /** The owner lets Synap Cloud recover accounts AND Cloud sign-in is wired. */
  cloud: boolean;
}

export interface RedeemRecoveryCodeRequest {
  email: string;
  /** As typed — the pod normalizes with {@link normalizeRecoveryCode}. */
  code: string;
}

export interface RedeemRecoveryCodeSuccess {
  ok: true;
  /**
   * Open this in a browser (Relay: the system auth session). It is pod-admin's
   * `/recovery?flow=<id>#code=<one-time code>`: the page reads the fragment,
   * completes the Kratos recovery flow, and lands in a privileged
   * `/settings/security` to set a new password. Single use, short-lived.
   */
  continueUrl: string;
  /** When the one-time Kratos recovery flow behind `continueUrl` expires. */
  expiresAt: string;
  /** The account's other sessions were signed out before this answer. */
  sessionsRevoked: boolean;
}

/**
 * `invalid_code` is the ONE answer for a wrong email, a wrong code, a used code
 * and an account with no codes — never distinguish them (enumeration).
 */
export type AccountRecoveryErrorCode =
  | "invalid_code"
  | "rate_limited"
  | "recovery_unavailable"
  | "invalid_request"
  | "unauthorized"
  | "reauth_required"
  | "cloud_session_not_allowed"
  | "forbidden";

export interface AccountRecoveryError {
  ok: false;
  error: AccountRecoveryErrorCode;
  message: string;
}

export interface AccountRecoveryStatus {
  recoveryCodes: {
    /** An unused batch exists for the signed-in account. */
    set: boolean;
    remaining: number;
    total: number;
    /** ISO timestamp of the current batch; null when none was ever made. */
    createdAt: string | null;
  };
  courier: {
    /** Mail actually leaves the pod (a real SMTP relay, not the catch-all). */
    configured: boolean;
    status: "configured" | "catchall" | "unknown";
  };
  cloud: {
    trust: CloudTrustMode;
    /** Synap Cloud sign-in is wired on this pod (a CP OIDC client exists). */
    available: boolean;
    /** The caller may change `trust` (pod admin). */
    canEdit: boolean;
  };
  session: {
    /** Signed in within Kratos' privileged window (15 min). */
    privileged: boolean;
    /** This session was proven by Synap Cloud alone (no pod-held factor). */
    cloudOnly: boolean;
    /** The caller may create codes / change trust right now. */
    canManage: boolean;
  };
}

export interface GeneratedRecoveryCodes {
  ok: true;
  /** Shown ONCE, display-formatted. The pod keeps only hashes. */
  codes: string[];
  createdAt: string;
}

export interface SetCloudTrustRequest {
  mode: CloudTrustMode;
}
