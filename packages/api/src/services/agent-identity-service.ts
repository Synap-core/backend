/**
 * Agent Identity Service
 *
 * Single enforcement point for the contract between the two agent representations
 * (the canonical hybrid every mature platform — GitHub Apps, Slack, Salesforce
 * Agentforce, Entra Agent ID — converges on):
 *
 *   - `agents` REGISTRY row  → capabilities, routing, intelligenceServiceId
 *   - `users` (userType='agent') row → authorship, workspace membership, permissions
 *
 * The 1:1 link is `agents.userId`. The user row is OPTIONAL: fully autonomous
 * agents (e.g. cron workers) need only the registry row, so resolveAgentUser
 * returns null gracefully when no user row is linked.
 *
 * Authorship follows the emerging on-behalf-of model (RFC 8693): an action is
 * 'delegated' when a human triggered it (human is subject, agent is actor) and
 * 'autonomous' when the agent acted on its own.
 */

import { db, eq } from "@synap/database";
import { agents, users } from "@synap/database/schema";

type AgentRow = typeof agents.$inferSelect;
type UserRow = typeof users.$inferSelect;

export type AuthorshipMode = "autonomous" | "delegated";

/** Fetch a registry row by id (or null). */
export async function getAgentById(agentId: string): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the agent's linked user row (authorship/permission identity), or null
 * when the agent has no user identity (autonomous-only registry agent).
 */
export async function resolveAgentUser(
  agentId: string
): Promise<UserRow | null> {
  const agent = await getAgentById(agentId);
  if (!agent?.userId) return null;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, agent.userId))
    .limit(1);
  return user ?? null;
}

/** Whether a registry agent has a paired user identity. */
export async function hasUserIdentity(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  return Boolean(agent?.userId);
}

/**
 * Enforce the 1:1 registry↔user link by populating agents.userId.
 * Call this from agent/agent-user creation flows so the contract holds.
 */
export async function linkAgentToUser(
  agentId: string,
  userId: string
): Promise<void> {
  await db
    .update(agents)
    .set({ userId, updatedAt: new Date() })
    .where(eq(agents.id, agentId));
}

/**
 * Derive the authorship mode for a mutation/proposal.
 * - null      → no agent involved (a human acted directly)
 * - delegated → an agent acted because a (different) human triggered it
 * - autonomous→ an agent acted on its own
 */
export function deriveAuthorshipMode(
  callingUserId: string | undefined,
  agentUserId: string | undefined
): AuthorshipMode | null {
  if (!agentUserId) return null;
  if (callingUserId && callingUserId !== agentUserId) return "delegated";
  return "autonomous";
}
