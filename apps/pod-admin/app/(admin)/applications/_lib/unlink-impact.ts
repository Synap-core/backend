/**
 * What the "Unlink {email}" confirm says about the person's sign-in once
 * unlinked. The server reads it as a FACT per person
 * (`applicationConnections.get` → `people[].unlinkImpact`, `unlinkImpacts`):
 * the confirm states a lockout only when it is true, never as a conditional.
 * Pure, so the confirm and its test read one rule.
 */

export type UnlinkImpact =
  "keeps_a_way_in" | "email_recovery_only" | "no_way_in" | "unknown";

export interface UnlinkSignInNotice {
  tone: "danger" | "warning";
  text: string;
}

/**
 * The callout under what the unlink takes away, or null when they keep a way
 * in. `cloudSignIn`: the unlink also removes Continue with Synap Cloud
 * (`unlinkReach.cloudSignIn`); without it, no sign-in method goes.
 */
export function unlinkSignInNotice(
  impact: UnlinkImpact,
  cloudSignIn: boolean,
  who: string
): UnlinkSignInNotice | null {
  if (!cloudSignIn) return null;
  switch (impact) {
    case "keeps_a_way_in":
      return null;
    case "no_way_in":
      return {
        tone: "danger",
        text: `${who} has no password, passkey or recovery code on this Pod, and this Pod sends no email to recover an account. Once unlinked, they have no way to sign in.`,
      };
    case "email_recovery_only":
      return {
        tone: "warning",
        text: `${who} has no password, passkey or recovery code on this Pod. Once unlinked, they can get back in only by recovering their account by email.`,
      };
    case "unknown":
      return {
        tone: "warning",
        text: `We couldn't check whether ${who} has another way to sign in to this Pod. Without a password, passkey or recovery code, they can no longer sign in.`,
      };
  }
}
