/**
 * The review page's heading — what APPROVING WILL DO, in words.
 *
 * An Application asking for reach (`app/connect`) reads "<app> asks for
 * access" with one line per space, through the ONE wording every door shares
 * (`describeAppConnectProposal`); an agent's held-writes pack
 * (`agent/held_writes`) names the agent whose writes wait
 * (`describeHeldWritesProposal`) — it read "Held writes Agent"; a tool run
 * (`capability.run`) is the call it makes, its action and its tool ("Create
 * server · Hetzner cloud", the pod's `review.toolRun`) — it read "Run Tool";
 * every other proposal is its imperative verb + noun
 * (`buildObjectActionTitle`), never the raw `proposalType` token.
 */

import {
  describeAppConnectProposal,
  type AppConnectSummary,
} from "@synap-core/types/proposals/intent";
import { describeHeldWritesProposal } from "@synap-core/types/proposals/deferred-writes";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { proposalPageT } from "./copy";
import { reviewToolRun } from "./tool-run-model";

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
    /** The agent that filed it, as the pod resolved its name. */
    agentActorName?: string | null;
    /** The pod's review; a tool run carries the call (`toolRun`). */
    review?: unknown;
  },
  payload: unknown
): ProposalHeading {
  const appConnect = describeAppConnectProposal({
    targetType: p.targetType,
    proposalType: p.proposalType,
    data: payload,
  });
  const heldWrites = describeHeldWritesProposal({
    targetType: p.targetType,
    proposalType: p.proposalType,
    targetName: p.targetName,
    agentName: p.agentActorName,
    data: payload,
  });
  const toolRun = reviewToolRun(p.review);
  const toolRunTitle = toolRun
    ? toolRun.tool
      ? proposalPageT()("toolRun.heading", {
          action: toolRun.action,
          tool: toolRun.tool,
        })
      : toolRun.action
    : null;
  return {
    appConnect,
    heading:
      appConnect?.title ??
      heldWrites?.title ??
      toolRunTitle ??
      buildObjectActionTitle({
        action: String(p.proposalType ?? "change"),
        objectKind: String(p.targetType ?? ""),
        objectName: p.targetName ? String(p.targetName) : undefined,
      }),
  };
}
