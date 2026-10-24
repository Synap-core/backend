/**
 * The NAME a link write's proposal carries (`data.title`): "Session blocked
 * by session", "Project uses space" — words from the vocabulary door, never
 * the edge's machine form (`session --blocked_by--> session`). The proposal
 * title (`Create Link "<name>"`) and the receipt session named after it read
 * it; the machine form came out of the receipt's title builder as "session
 * session" (dogfood e3c39721 §4). ONE spelling for every link door.
 */

export function linkProposalTitle(edge: {
  fromType: string;
  linkType: string;
  toType: string;
}): string {
  return `${edge.fromType} --${edge.linkType}--> ${edge.toType}`;
}
