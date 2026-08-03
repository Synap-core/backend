/**
 * Agent provenance — WHERE an agent came from, for the Agent dashboard.
 *
 * Identity + origin from the governance-actor row (`users`, keyed by the same
 * `agentUserId` the scorecard uses). Origin is now a stored fact (`created_via`,
 * migration 0225); scope (pod-wide vs workspace) is DERIVED from the presence of
 * `workspace_members` rows — the same signal `provisionAgent` uses to detect an
 * already-pod-wide agent. Owner-floored: only the caller's own agent-users, so a
 * guessed id can't leak another owner's agent identity.
 */

import {
  db,
  and,
  eq,
  inArray,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database";

export interface AgentProfile {
  agentUserId: string;
  name: string | null;
  agentType: string | null;
  agentTemplate: string | null;
  isPersonalAgent: boolean;
  /** 'cli' | 'intelligence-service' | 'ui' | 'system' | null (pre-0225). */
  createdVia: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  scope: "pod-wide" | "workspace";
  workspaces: Array<{ id: string; name: string | null }>;
}

export async function agentProfile(params: {
  userId: string;
  agentId: string;
}): Promise<AgentProfile | { error: string }> {
  const { userId, agentId } = params;

  const [agent] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentType: users.agentType,
      agentTemplate: users.agentTemplate,
      isPersonalAgent: users.isPersonalAgent,
      createdVia: users.createdVia,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    // OWNER FLOOR — only the caller's own agent-users (mirrors agentScorecard).
    .where(and(eq(users.id, agentId), eq(users.createdByUserId, userId)))
    .limit(1);

  if (!agent || agent.userType !== "agent") {
    return { error: `No agent-user found for id ${agentId}` };
  }

  let createdByName: string | null = null;
  if (agent.createdByUserId) {
    const [owner] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, agent.createdByUserId))
      .limit(1);
    createdByName = owner?.name ?? owner?.email ?? null;
  }

  // Scope: workspace-membership presence. No rows ⇒ pod-wide (the sovereign
  // whole-brain agent), matching how provisionAgent detects a pod-wide agent.
  const memberRows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, agentId));
  const wsIds = memberRows.map((r) => r.workspaceId);

  let wsList: Array<{ id: string; name: string | null }> = [];
  if (wsIds.length > 0) {
    wsList = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(inArray(workspaces.id, wsIds));
  }

  return {
    agentUserId: agent.id,
    name: agent.name ?? agent.email ?? null,
    agentType: agent.agentType ?? null,
    agentTemplate: agent.agentTemplate ?? null,
    isPersonalAgent: agent.isPersonalAgent,
    createdVia: agent.createdVia ?? null,
    createdByUserId: agent.createdByUserId ?? null,
    createdByName,
    scope: wsIds.length > 0 ? "workspace" : "pod-wide",
    workspaces: wsList,
  };
}
