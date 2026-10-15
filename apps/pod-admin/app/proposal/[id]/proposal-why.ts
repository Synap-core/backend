/**
 * The review page's two WHYs — kept apart on purpose.
 *
 * `policy` is why a PERSON must decide: the governance engine's sentence,
 * named by `governanceReason`. `proposer` is why the proposer wants the change:
 * their own reasoning. Until 2026-10-12 the pod stored the policy sentence AS
 * the reasoning whenever the proposer gave none, so this page printed "Agent
 * requires proposal for all write operations." as if the agent had said it.
 * Rows written before then still carry it — `isGovernancePolicySentence` is
 * how they are told apart, and a legacy row with no code still yields its
 * policy sentence rather than losing it. The same sentence is never returned
 * twice.
 */

import {
  GOVERNANCE_POLICY_SENTENCES,
  isGovernancePolicySentence,
} from "@synap-core/types/proposals";

export interface ProposalWhy {
  /** Why approval is required, in the policy's words. */
  policy?: string;
  /** The proposer's own reasoning — only when it is genuinely theirs. */
  proposer?: string;
}

export function proposalWhy({
  governanceReason,
  reasoning,
}: {
  governanceReason?: string | null;
  reasoning?: unknown;
}): ProposalWhy {
  const text =
    typeof reasoning === "string" && reasoning.trim()
      ? reasoning.trim()
      : undefined;
  const legacyPolicy = isGovernancePolicySentence(text);
  // `Object.hasOwn`, not `in`: a code is stored text, and "toString" is not a
  // governance reason.
  const coded =
    governanceReason &&
    Object.hasOwn(GOVERNANCE_POLICY_SENTENCES, governanceReason)
      ? GOVERNANCE_POLICY_SENTENCES[
          governanceReason as keyof typeof GOVERNANCE_POLICY_SENTENCES
        ]
      : undefined;
  return {
    policy: coded ?? (legacyPolicy ? text : undefined),
    proposer: text && !legacyPolicy ? text : undefined,
  };
}
