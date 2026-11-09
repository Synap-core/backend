/**
 * The person's ONE personal AI — the agent identity every Synap AI turn acts
 * as (founder, 2026-11-09: "My one personal AI"; decision 6b45c6c3).
 *
 * Every intelligence-service turn — a playbook run's turn, a chat in any room,
 * an app's chat, a background turn — is the pod's AI working for the person,
 * so it writes as THIS agent, on the person's behalf, under this agent's own
 * governance ladder and the person's Synap AI ceiling. Never as the person,
 * and never as an identity chosen by space membership or by the playbook. The
 * agent types (meta, personal, specialists) are modes of this one AI, not
 * identities of their own. An external worker (Claude Code, Hermes...) is a
 * different agent and acts as itself with its own key.
 *
 * Membership is NOT this module's concern, on purpose: nothing enrolls the AI
 * in a space silently. A write in a space it is not a member of goes to the
 * governance gate (a `workspace.join` proposal or a refusal with its reason).
 *
 * Lives in @synap/database so the routing package (`@synap/intelligence-
 * client`) and the API share ONE find-or-create. `database` is injectable so a
 * caller's own (test-swapped) handle is the one used.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../client-pg.js";
import { users } from "../schema/users.js";

type Database = typeof defaultDb;

async function findPersonalAgentUserId(
  database: Database,
  userId: string
): Promise<string | null> {
  const [row] = await database
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

/** The person's personal agent, created once (pod-wide, no membership). */
export async function ensurePersonalAgentUser(
  userId: string,
  database: Database = defaultDb
): Promise<string> {
  const existing = await findPersonalAgentUserId(database, userId);
  if (existing) return existing;

  const newId = randomUUID();
  const shortId = newId.slice(0, 8);
  try {
    const [agentUser] = await database
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
    return agentUser!.id;
  } catch (err) {
    // DB firewall: a partial unique index on (createdByUserId, agentType) for
    // personal agents rejects a concurrent insert. Reuse the winner; if nothing
    // matches, the error wasn't a dedup race — re-throw.
    const raced = await findPersonalAgentUserId(database, userId);
    if (!raced) throw err;
    return raced;
  }
}
