/**
 * AGENT HAND-OFF — an AI agent putting ANOTHER agent on a session's roster.
 *
 * Founder decision (2026-10-12): "If not overridden, ask for approval for
 * non-cancelable actions." Adding an agent to a roster is how work is handed
 * to it: a worker polling for sessions that name it picks the session up, an
 * external agent spends a provider run. None of that can be called back. So
 * when an AGENT does it for an agent other than itself, it is its own governed
 * write, `focus_session/assign_agent` — not in DEFAULT_AUTO_APPROVE, so it
 * PROPOSES by default, and a `governance_rules` row that says `auto` for it
 * (rung 2.8) is the override.
 *
 * Who never reaches this door:
 *  - a PERSON staffing their own session (no `agentUserId`): applied directly,
 *    exactly as before — relay "Give to agent" is this path;
 *  - an agent adding ITSELF: joining work is not handing it to anyone.
 *
 * ONE gate, every door: `updateFocusSession` (MCP `synap_update_session`
 * `addAgentId`), Hub `PATCH /focus-sessions/:id` (`addAgentId` and the
 * additions inside a wholesale `agentIds`), and `createFocusSession` (an
 * agent's start naming other agents). Each asks per added agent, so a proposal
 * names exactly one hand-off and approving it attaches exactly that agent
 * (`focus_session/assign_agent` executor → `attachSessionAgent`).
 */
import { checkPermissionOrPropose } from "../../utils/permission-check.js";

/** The agents in `agentIds` that are NOT the acting agent (a hand-off), deduped. */
export function handedOffAgentIds(
  agentUserId: string | null | undefined,
  agentIds: readonly string[]
): string[] {
  if (!agentUserId) return [];
  const out: string[] = [];
  for (const raw of agentIds) {
    const id = raw.trim();
    if (id !== "" && id !== agentUserId && !out.includes(id)) out.push(id);
  }
  return out;
}

export type AgentHandOffDecision =
  | { status: "granted"; agentId: string }
  | { status: "denied"; agentId: string; reason: string }
  | {
      status: "proposed";
      agentId: string;
      proposalId: string;
      proposalType?: string;
      summary?: string;
      reviewPath?: string;
      reviewUrl?: string;
    };

/**
 * Ask the governance door whether this agent may hand `sessionId` to
 * `agentId`. `granted` ⇒ the caller attaches now; `proposed` ⇒ the proposal
 * carries `addAgentId` and approval attaches it; `denied` ⇒ nothing happens.
 * The caller has already established `agentId` is not the acting agent.
 */
export async function gateAgentHandOff(p: {
  userId: string;
  agentUserId: string;
  workspaceId: string | null | undefined;
  sessionId: string;
  /** The session's goal — the proposal's summary label. */
  goal: string | null | undefined;
  agentId: string;
  reasoning?: string;
}): Promise<AgentHandOffDecision> {
  const perm = await checkPermissionOrPropose({
    userId: p.userId,
    agentUserId: p.agentUserId,
    workspaceId: p.workspaceId ?? undefined,
    subjectType: "focus_session",
    action: "assign_agent",
    source: "intelligence",
    ...(p.reasoning ? { reasoning: p.reasoning } : {}),
    data: {
      id: p.sessionId,
      goal: p.goal ?? null,
      addAgentId: p.agentId,
    },
  });
  if ("denied" in perm && perm.denied) {
    return { status: "denied", agentId: p.agentId, reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      agentId: p.agentId,
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }
  return { status: "granted", agentId: p.agentId };
}
