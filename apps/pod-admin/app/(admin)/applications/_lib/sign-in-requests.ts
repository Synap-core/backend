/**
 * "Sign in with your pod" connection REQUESTS that are not waiting on anyone
 * here: mid-flight handshakes and the archive. Waiting ones are decided in
 * Review (`pendingSummary` only counts them); these are shown for visibility.
 */

import { resolveStatusLabel } from "@synap-core/types/vocabulary";

export interface SignInRequestLike {
  id: string;
  displayName: string;
  issuerUrl: string;
  requestedOrigin: string;
  status: string;
}

/**
 * Human label for a connection-request status. The status WORD comes from the
 * vocabulary (`resolveStatusLabel`, what `/connection-requests/[id]` reads);
 * two keep local phrasing because they carry what the status alone does not:
 *   • `awaiting_local_auth` names WHAT is being waited on — the app must
 *     finish the handshake;
 *   • `approved` here is approved-but-not-yet-complete; flattening it to
 *     "Approved" would say the flow finished when it has not.
 */
export function requestStateLabel(status: string): string {
  if (status === "awaiting_local_auth") return "Waiting for the app";
  if (status === "approved") return `${resolveStatusLabel(status)} · finishing`;
  return resolveStatusLabel(status);
}

const IN_PROGRESS = new Set(["awaiting_local_auth", "approved", "completing"]);
const ARCHIVED = new Set(["expired", "rejected", "completed"]);

/**
 * Split the requests the list does not decide: started-but-unfinished (not
 * owner-actionable) and the archive (timed out, declined, done). `pending`
 * belongs to Review and is in neither.
 */
export function splitSignInRequests<R extends SignInRequestLike>(
  requests: readonly R[]
): { inProgress: R[]; archived: R[] } {
  return {
    inProgress: requests.filter((r) => IN_PROGRESS.has(r.status)),
    archived: requests.filter((r) => ARCHIVED.has(r.status)),
  };
}

/** Where one request is shown in full (a self-service page, also the requester's). */
export function signInRequestHref(id: string): string {
  return `/connection-requests/${encodeURIComponent(id)}`;
}
