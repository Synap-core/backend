/**
 * What the "Unlink {email}" confirm marks about the person's sign-in once
 * unlinked. The server reads it as a FACT per person
 * (`applicationConnections.get` → `people[].unlinkImpact`, `unlinkImpacts`):
 * the confirm marks a lockout only when it is true, never as a conditional.
 * A mark (tone + the vocabulary's word for the value) plus one sentence.
 * Pure, so the confirm and its test read one rule.
 */

import { humanizeToken } from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../components/status-pill";

export type UnlinkImpact =
  "keeps_a_way_in" | "email_recovery_only" | "no_way_in" | "unknown";

export interface UnlinkSignInNotice {
  kind: StatusKind;
  label: string;
  sentence: string;
}

/**
 * The mark under what the unlink takes away, or null when they keep a way in
 * (OMIT). `cloudSignIn`: the unlink also removes Continue with Synap Cloud
 * (`unlinkReach.cloudSignIn`); without it, no sign-in method goes.
 */
export function unlinkSignInNotice(
  impact: UnlinkImpact,
  cloudSignIn: boolean,
  who: string
): UnlinkSignInNotice | null {
  if (!cloudSignIn || impact === "keeps_a_way_in") return null;
  const label = humanizeToken(impact);
  switch (impact) {
    case "no_way_in":
      return {
        kind: "down",
        label,
        sentence: `${who} has no password, passkey or recovery code here, and this Pod sends no email.`,
      };
    case "email_recovery_only":
      return {
        kind: "stale",
        label,
        sentence: `${who} has no password, passkey or recovery code here: recovering by email is their way back.`,
      };
    case "unknown":
      return {
        kind: "unknown",
        label,
        sentence: `We couldn't check whether ${who} keeps another way to sign in.`,
      };
  }
}
