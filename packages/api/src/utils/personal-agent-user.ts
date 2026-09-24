/**
 * The owner's pod-wide personal AI agent user (the orchestrator identity that
 * answers "@ai"). ONE agent user per human, shared across every workspace —
 * find it, or create it once. Workspace membership is NOT this module's
 * concern: `ensureAgentUser` (routers/channels/helpers.ts) layers it on top for
 * workspace-scoped turns; a pod-scoped session room needs only the identity.
 */
import { randomUUID } from "crypto";
import { db, eq, and } from "@synap/database";
import { users } from "@synap/database/schema";

async function findPersonalAgentUserId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        eq(users.createdByUserId, userId),
        eq(users.isPersonalAgent, true)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

export async function ensurePersonalAgentUser(userId: string): Promise<string> {
  const existing = await findPersonalAgentUserId(userId);
  if (existing) return existing;

  const newId = randomUUID();
  const shortId = newId.slice(0, 8);
  try {
    const [agentUser] = await db
      .insert(users)
      .values({
        id: newId,
        email: `agent-orchestrator-${shortId}@synap.agent`,
        userType: "agent",
        kratosIdentityId: null,
        createdByUserId: userId,
        agentType: "orchestrator",
        isPersonalAgent: true,
        createdVia: "system",
        agentMetadata: {
          createdByUserId: userId,
          agentType: "orchestrator",
          isPersonalAgent: true,
        },
      })
      .returning({ id: users.id });
    return agentUser.id;
  } catch (err) {
    // DB firewall: a partial unique index on (createdByUserId, agentType) for
    // personal agents rejects a concurrent insert. Reuse the winner; if nothing
    // matches, the error wasn't a dedup race — re-throw.
    const raced = await findPersonalAgentUserId(userId);
    if (!raced) throw err;
    return raced;
  }
}
