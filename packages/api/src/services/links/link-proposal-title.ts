/**
 * The NAME a link write's proposal carries (`data.title`): "Job blocked by
 * job", "Project uses space" — words from the vocabulary door, never
 * the edge's machine form (`session --blocked_by--> session`). The proposal
 * title (`Create Link "<name>"`) and the receipt session named after it read
 * it; the machine form came out of the receipt's title builder as "session
 * session" (dogfood e3c39721 §4). ONE spelling for every link door.
 */
import {
  nounInSentence,
  resolveLineageEdgeLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";

export function linkProposalTitle(edge: {
  fromType: string;
  linkType: string;
  toType: string;
}): string {
  return [
    resolveObjectNoun(edge.fromType),
    nounInSentence(resolveLineageEdgeLabel(edge.linkType, "outgoing")),
    nounInSentence(resolveObjectNoun(edge.toType)),
  ]
    .filter(Boolean)
    .join(" ");
}
