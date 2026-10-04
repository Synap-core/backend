/**
 * Browser client for the pod's `/api/account-recovery/*` (contract:
 * `@synap-core/types/account-recovery`), plus the pure rules the recovery and
 * security pages render from.
 *
 * Errors are RETURNED with their code, never thrown and never folded into an
 * empty answer: "no doors work" and "the doors read failed" are different
 * screens (EXPLAIN vs LoadFailed).
 */

import type {
  AccountRecoveryErrorCode,
  AccountRecoveryStatus,
  CloudTrustMode,
  GeneratedRecoveryCodes,
  RecoveryDoors,
  RedeemRecoveryCodeSuccess,
} from "@synap-core/types/account-recovery";
import {
  POD_PUBLIC_URL_CONFIGURATION_ERROR,
  publicPodUrl,
} from "./public-pod-url";

export type RecoveryCall<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      error: AccountRecoveryErrorCode | "network";
      message: string;
    };

async function call<T>(
  path: string,
  init: RequestInit = {}
): Promise<RecoveryCall<T>> {
  const pod = publicPodUrl();
  if (!pod) {
    return {
      ok: false,
      status: 0,
      error: "network",
      message: POD_PUBLIC_URL_CONFIGURATION_ERROR,
    };
  }
  let res: Response;
  try {
    res = await fetch(`${pod.replace(/\/$/, "")}/api/account-recovery${path}`, {
      credentials: "include",
      cache: "no-store",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: "network",
      message: "Could not reach this pod.",
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.ok) return { ok: true, data: body as T };
  const err = (body ?? {}) as { error?: unknown; message?: unknown };
  return {
    ok: false,
    status: res.status,
    error:
      typeof err.error === "string"
        ? (err.error as AccountRecoveryErrorCode)
        : res.status === 401
          ? "unauthorized"
          : "recovery_unavailable",
    message:
      typeof err.message === "string"
        ? err.message
        : `This pod answered ${res.status}.`,
  };
}

export const recoveryApi = {
  doors: () => call<RecoveryDoors>("/doors"),
  redeem: (email: string, code: string) =>
    call<RedeemRecoveryCodeSuccess>("/redeem", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    }),
  status: () => call<AccountRecoveryStatus>("/status"),
  generateCodes: () =>
    call<GeneratedRecoveryCodes>("/codes", { method: "POST" }),
  setCloudTrust: (mode: CloudTrustMode) =>
    call<AccountRecoveryStatus>("/cloud-trust", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    }),
};

export type RecoveryDoorKind = "code" | "email" | "cloud";

/** The doors to render, in the one order every surface uses. */
export function visibleDoors(doors: RecoveryDoors): RecoveryDoorKind[] {
  const out: RecoveryDoorKind[] = [];
  if (doors.recoveryCode) out.push("code");
  if (doors.email) out.push("email");
  if (doors.cloud) out.push("cloud");
  return out;
}

/**
 * The one-time Kratos code a redeem hands over in the URL FRAGMENT
 * (`/recovery?flow=…#code=…`). The fragment never reaches a server; the page
 * reads it once and scrubs it from the address bar.
 */
export function readRecoveryFragment(hash: string): string | null {
  const m = /(?:^#|&)code=([^&]+)/.exec(hash);
  if (!m) return null;
  const code = decodeURIComponent(m[1]!).trim();
  return /^[0-9]{4,12}$/.test(code) ? code : null;
}

/** Plain-text file for "Download": the codes plus where they work. */
export function recoveryCodesFile(input: {
  codes: string[];
  podUrl: string;
  email: string | null;
  createdAt: string;
}): string {
  return [
    "Synap pod recovery codes",
    "",
    `Pod: ${input.podUrl}`,
    ...(input.email ? [`Account: ${input.email}`] : []),
    `Created: ${input.createdAt}`,
    "",
    "Each code works once. Use one at the pod's sign-in page:",
    "\"Can't sign in?\" → \"Use a recovery code\".",
    "Creating new codes makes these stop working.",
    "",
    ...input.codes,
    "",
  ].join("\n");
}

/** The technical detail of a failed call — for "Copy details", never the sentence. */
export function recoveryCallDetail(r: {
  status: number;
  error: string;
  message: string;
}): string {
  return `${r.status || "no answer"} · ${r.error} · ${r.message}`;
}

/**
 * A failed redeem as one fixed sentence. `invalid_code` never says WHICH part
 * was wrong (enumeration); the pod's own message is never shown — it can be a
 * bare `This pod answered 503.`
 */
export function redeemFailureMessage(error: AccountRecoveryErrorCode | "network"): {
  message: string;
  /** The pod could not answer — worth offering the detail. */
  failed: boolean;
} {
  switch (error) {
    case "invalid_code":
    case "invalid_request":
      return { message: "That didn't work. Check the email and the code — each code works once.", failed: false };
    case "rate_limited":
      return { message: "Too many tries. Wait a few minutes, then try again.", failed: false };
    case "network":
      return { message: "Couldn't reach this pod. Your code was not used.", failed: true };
    default:
      return { message: "The pod couldn't check codes right now. Your code was not used.", failed: true };
  }
}
