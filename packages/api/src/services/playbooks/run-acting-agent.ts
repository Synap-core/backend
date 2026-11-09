/**
 * WHICH AI a playbook run's turn acts as (founder, 2026-11-09: "a run acts as
 * the AI agent used for it").
 *
 * A run turn is an AI's work, governed as an AI's work: its writes go through
 * the agent ladder and propose per that agent's policy. The person stays the
 * operator (`sub`: their read floor, on their behalf); the agent is the actor
 * (`act.sub`, which the pod signs and `resolveActorId` accepts).
 *
 * The agent is the space's house agent when exactly one resolves
 * (`resolveIntelligenceService(...).agentUserId`, `lookupAgentUser`). Before
 * this, when none did (0 or 2+ house agents in the space, e.g. Content OS),
 * the turn named NO agent and every write ran as the person, applied with no
 * proposal: one run reviewed, the same run in another space not (live
 * 2026-11-09: "Plan Next Content" applied update_entities directly). Now it
 * falls back to the person's own Synap AI (`ensurePersonalAgentUser`),
 * enrolled in the space the way the chat door enrolls it (`ensureAgentUser`:
 * editor, owner in an agent-owned space), so its writes reach the ladder
 * instead of filing a `workspace.join`.
 *
 * Only for run turns (`triggerAutoRespond`'s `run`: the is-agent kickoff and
 * the automatic continuation). Any other headless turn keeps its routing.
 */

import { ensurePersonalAgentUser } from "../../utils/personal-agent-user.js";

export async function runActingAgentUserId(p: {
  /** The house agent routing resolved for the operator + space, if exactly one. */
  houseAgentUserId: string | undefined;
  /** The turn's operator (the TurnPrincipal). */
  operatorUserId: string;
  /** The run room's space; null = a personal (pod-scoped) run. */
  workspaceId: string | null;
}): Promise<string> {
  if (p.houseAgentUserId) return p.houseAgentUserId;
  if (!p.workspaceId) return ensurePersonalAgentUser(p.operatorUserId);
  const { ensureAgentUser } = await import("../../routers/channels/helpers.js");
  return ensureAgentUser(p.operatorUserId, p.workspaceId);
}
