/**
 * Agent Identity Service
 *
 * Contracts the two agent representations: the `agents` REGISTRY row (capabilities,
 * routing) and the optional `users` (userType='agent') row (authorship, permissions),
 * linked 1:1 via `agents.userId`. The user row is optional — autonomous agents
 * (e.g. cron workers) need only the registry row, so resolveAgentUser returns null
 * gracefully when no user row is linked.
 *
 * Authorship: 'delegated' when a human triggered the action, else 'autonomous'.
 */

import { db, eq, and } from "@synap/database";
import { agents, users, apiKeys } from "@synap/database/schema";
import { randomUUID, randomBytes } from "crypto";

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
 * Populate the 1:1 registry↔user link (agents.userId). Intended to be called
 * from the agent / agent-user creation flows; not yet wired there.
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

export interface CreateNamedAgentResult {
  agentUserId: string;
  email: string;
  /** Plaintext Hub Protocol API key — shown once, never retrievable. */
  apiKey: string;
}

/**
 * Creates a named agent user (userType="agent") and issues a Hub Protocol
 * API key for it. Idempotent by (agentType + createdByUserId): if an agent
 * of the same type already exists for this user, a fresh key is issued for
 * the existing agent rather than creating a duplicate.
 *
 * The key's `linkedUserId` is set to `createdByUserId` so the Hub Protocol
 * middleware can auto-inject `agentUserId` for proposal attribution.
 */
export async function createNamedAgent(opts: {
  name: string;
  agentType: string;
  createdByUserId: string;
}): Promise<CreateNamedAgentResult> {
  // Idempotent lookup: reuse existing agent of same type for this user
  const [existing] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.createdByUserId, opts.createdByUserId),
        eq(users.userType, "agent"),
        eq(users.agentType, opts.agentType),
        eq(users.isPersonalAgent, false)
      )
    )
    .limit(1);

  let agentUserId: string;
  let email: string;

  if (existing) {
    agentUserId = existing.id;
    email = existing.email;
  } else {
    agentUserId = randomUUID();
    const shortId = agentUserId.slice(0, 8);
    email = `agent-${opts.agentType}-${shortId}@synap.agent`;

    await db.insert(users).values({
      id: agentUserId,
      email,
      name: opts.name,
      userType: "agent",
      agentType: opts.agentType,
      isPersonalAgent: false,
      createdByUserId: opts.createdByUserId,
      agentMetadata: {
        agentType: opts.agentType,
        createdByUserId: opts.createdByUserId,
        isPersonalAgent: false,
      },
      kratosIdentityId: `agent:${agentUserId}`,
    });
  }

  // Issue a fresh session API key for this agent
  const plainKey = `synap_hub_live_${randomBytes(32).toString("hex")}`;
  const keyId = randomUUID();

  // Use bcrypt to hash — import dynamically to avoid circular deps
  const bcrypt = await import("bcrypt");
  const keyHash = await bcrypt.hash(plainKey, 12);

  await db.insert(apiKeys).values({
    id: keyId,
    userId: agentUserId,
    keyName: opts.name,
    keyPrefix: plainKey.slice(0, 16),
    keyHash,
    keyType: "hub_inbound",
    scope: ["hub-protocol.read", "hub-protocol.write"],
    isActive: true,
    linkedUserId: opts.createdByUserId,
    createdBy: opts.createdByUserId,
  });

  return { agentUserId, email, apiKey: plainKey };
}
