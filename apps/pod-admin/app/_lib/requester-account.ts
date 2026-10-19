/**
 * The account a connection request will give access to, as the reviewer
 * reads it. The Pod verified it when the request started
 * (`requesterAccountView`, @synap/api); this only turns that into a mark and
 * two lines. The issuer's raw subject is never shown: it is an opaque id a
 * person cannot recognise.
 */

import type { RequesterAccountView } from "@synap-core/api-types";

export interface RequesterAccountLine {
  tone: "success" | "warning";
  mark: string;
  title: string;
  detail: string;
}

/** null: this reader may not review, so the account is not theirs to see. */
export function requesterAccountLine(
  account: RequesterAccountView | null | undefined
): RequesterAccountLine | null {
  if (!account) return null;
  if (account.status === "verified") {
    return {
      tone: "success",
      mark: "Verified",
      title: account.email,
      detail: `Synap account, verified by ${account.issuerHost}`,
    };
  }
  return {
    tone: "warning",
    mark: "Not verified",
    title: "Account not verified",
    detail:
      "The app did not prove which account will receive access. Allow it only if you know who started this request.",
  };
}
