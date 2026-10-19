/**
 * The words of an account-link request, for the person reviewing it and for
 * the person who asked. The Pod verified the account when the request
 * started (`requesterAccountView`, @synap/api); this turns that, and the Pod
 * member it will sign in as, into headings and marks. The issuer's raw
 * subject is never shown: it is an opaque id a person cannot recognise.
 */

import type { RequesterAccountView } from "@synap-core/api-types";
import { resolveAccountTrustLabel } from "@synap-core/types/vocabulary";

export type AccountTone = "success" | "warning";

/** The Pod member the account will sign in as (reviewers only). */
export interface RequesterMemberView {
  name: string | null;
  email: string | null;
}

export interface AccountLinkReview {
  /** "Let ada@example.com sign in as Ada?" */
  heading: string;
  /** "They'll see and do everything Ada can on this Pod." */
  body: string;
  member: { label: string; email: string | null };
  account: {
    verified: boolean;
    /** The address, or a plain statement that nobody vouched for one. */
    title: string;
    mark: string;
    tone: AccountTone;
    /** "Verified by Synap" — the issuer's name, else its host. */
    verifiedBy: string | null;
  };
  /** The member's address differs from the account's (both known). */
  differentEmail: boolean;
}

function memberLabel(member: RequesterMemberView | null | undefined): string {
  return member?.name?.trim() || member?.email?.trim() || "this Pod member";
}

/** The reviewer's view of an account link. */
export function accountLinkReview(
  account: RequesterAccountView,
  member: RequesterMemberView | null | undefined
): AccountLinkReview {
  const label = memberLabel(member);
  const memberEmail = member?.email?.trim() || null;
  const body = `They'll see and do everything ${label} can on this Pod.`;
  if (account.status === "verified") {
    return {
      heading: `Let ${account.email} sign in as ${label}?`,
      body,
      member: { label, email: memberEmail },
      account: {
        verified: true,
        title: account.email,
        mark: resolveAccountTrustLabel("verified"),
        tone: "success",
        verifiedBy: `Verified by ${account.issuerName ?? account.issuerHost}`,
      },
      differentEmail:
        memberEmail !== null &&
        memberEmail.toLowerCase() !== account.email.toLowerCase(),
    };
  }
  return {
    heading: `Let an unverified account sign in as ${label}?`,
    body,
    member: { label, email: memberEmail },
    account: {
      verified: false,
      title: "Nobody vouched for this account",
      mark: resolveAccountTrustLabel("unverified"),
      tone: "warning",
      verifiedBy: null,
    },
    differentEmail: false,
  };
}

export interface AccountLinkRequesterView {
  state: "waiting" | "linked";
  heading: string;
  body: string;
  /** Their own account, when it was verified. */
  email: string | null;
}

/** What the person who asked reads while the owner decides, and after. */
export function accountLinkRequesterView(input: {
  account: RequesterAccountView | null | undefined;
  appName: string;
  linked: boolean;
}): AccountLinkRequesterView {
  const email =
    input.account?.status === "verified" ? input.account.email : null;
  const who = email ?? "your Synap account";
  if (input.linked) {
    return {
      state: "linked",
      heading: "Linked",
      body: `${who} now signs in to your Pod account. ${input.appName} finishes on its own.`,
      email,
    };
  }
  return {
    state: "waiting",
    heading: "Waiting for the Pod owner",
    body: `We asked the Pod owner to link ${who} to your Pod account. You can close this page. ${input.appName} finishes on its own once they approve.`,
    email,
  };
}
