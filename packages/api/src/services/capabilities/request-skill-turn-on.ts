/**
 * The "turn this on?" request for an agent's skill that no person reviewed
 * (founder, 2026-10-28).
 *
 * An agent's skill created through a door a governance rule granted (`action
 * skill.create → auto`), or in a batch that auto-applied, is born switched OFF
 * (`skillBornApproved`) and nobody had been told: no review item, no
 * notification, and the agent read `created`. Now each such create files ONE
 * `capability.enable` request for the skill, through the one proposer
 * (`proposeCapabilityEnable`): it always proposes even where a rule would
 * grant, dedups, and its approval turns the skill on through the owner-gated
 * enable door. Code and instruction skills alike: instructions land in a
 * future agent's prompt.
 *
 * Not filed when the skill is born on (rule 3: an agent's code that reaches
 * nothing outside the pod), when a person wrote it, or when a person approved
 * its create proposal (that review was the OK; the skill is already on).
 */

import {
  proposeCapabilityEnable,
  type CapabilityEnableOffer,
} from "./propose-capability-enable.js";

export async function requestAgentSkillTurnOn(input: {
  skill: { id: string; name: string; approved: boolean | null };
  /** The skill's author when it is an agent; null/undefined = a person. */
  authorAgentUserId: string | null | undefined;
  /** A person approved the create proposal (no request: it is already on). */
  personReviewed: boolean;
  /** The pod user the skill belongs to. */
  userId: string;
  workspaceId: string | null;
  sessionId?: string | null;
}): Promise<CapabilityEnableOffer | null> {
  if (!input.authorAgentUserId || input.personReviewed || input.skill.approved)
    return null;
  const [offer] = await proposeCapabilityEnable({
    refused: [{ kind: "skill", id: input.skill.id, name: input.skill.name }],
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentUserId: input.authorAgentUserId,
    sessionId: input.sessionId ?? null,
  });
  return offer ?? null;
}

/**
 * The agent's answer for a create that landed switched off: what happened,
 * plainly, and where the person decides. Never a bare `created`.
 */
export function turnOnRequestMessage(
  name: string,
  offer: CapabilityEnableOffer
): string {
  return offer.status === "proposed"
    ? `Created "${name}", switched off: it runs or loads only once the person turns it on. A request to turn it on is waiting for their review: ${offer.reviewUrl}`
    : `Created "${name}", switched off: it runs or loads only once the person turns it on, and the request to turn it on could not be filed. Ask the person to turn it on (Settings → Capabilities).`;
}
