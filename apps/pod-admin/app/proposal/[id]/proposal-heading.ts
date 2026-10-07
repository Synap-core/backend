/**
 * The review page's heading — what APPROVING WILL DO, in words.
 *
 * An Application asking for reach (`app/connect`) reads "<app> asks for
 * access" with one line per space, through the ONE wording every door shares
 * (`describeAppConnectProposal`); every other proposal is its imperative verb +
 * noun (`buildObjectActionTitle`), never the raw `proposalType` token.
 */

import {
  describeAppConnectProposal,
  type AppConnectSummary,
} from "@synap-core/types/proposals/intent";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";

export interface ProposalHeading {
  heading: string;
  /** Present only for a readable app/connect request — its lines replace the raw payload. */
  appConnect: AppConnectSummary | null;
}

export function proposalHeading(
  p: {
    targetType?: string | null;
    targetName?: string | null;
    proposalType?: string | null;
  },
  payload: unknown
): ProposalHeading {
  const appConnect = describeAppConnectProposal({
    targetType: p.targetType,
    proposalType: p.proposalType,
    data: payload,
  });
  return {
    appConnect,
    heading:
      appConnect?.title ??
      buildObjectActionTitle({
        action: String(p.proposalType ?? "change"),
        objectKind: String(p.targetType ?? ""),
        objectName: p.targetName ? String(p.targetName) : undefined,
      }),
  };
}
