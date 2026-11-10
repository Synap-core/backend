/**
 * The person's ONE personal AI (decision 6b45c6c3): the agent every Synap AI
 * turn acts as. The find-or-create lives in @synap/database
 * (`utils/personal-agent-user.ts`) so the routing package shares it; this is
 * the API's door to it, on the API's own `db` handle.
 */
import { db, ensurePersonalAgentUser as ensureOn } from "@synap/database";

export async function ensurePersonalAgentUser(userId: string): Promise<string> {
  return ensureOn(userId, db);
}
