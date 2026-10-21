/**
 * Two small reads about an app's own agent (spec 17 PB4), kept apart from
 * `app-connect.ts` so the generic doors that need them (agent governance,
 * webhooks) do not pull the whole App Connect service into their import
 * graph. Only `db`, `eq`, `and` and the `apps` table.
 */

import { db, eq, and } from "@synap/database";
import { apps } from "@synap/database/schema";
import { isAgentCaller } from "./library/agent-door.js";

/** Is this user the agent of some app (App Connect or pod app)? */
export async function isAppAgent(agentUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.agentUserId, agentUserId))
    .limit(1);
  return !!row;
}

/**
 * The floor the generic agent-governance doors run: an app's write mode is
 * its owner's choice (`setAppWriteMode`, the app's page), so an AGENT's
 * credential may not change the rules of an app's agent there either
 * (`PATCH /agent-users/:id/governance`, `agentUsers.update`,
 * `governanceRules.create|revoke`). Without it an agent acting for the owner
 * passes those doors' "creator" check as the owner. `caller` is the door's
 * own caller context (tRPC `ctx`, Hub `c.get`). Returns the refusal, or null.
 */
export async function appAgentGovernanceDenial(
  targetAgentUserId: string | null | undefined,
  caller: { agentUserId?: string | null; keyType?: string | null }
): Promise<string | null> {
  if (!targetAgentUserId) return null;
  if (!isAgentCaller(caller)) return null;
  if (!(await isAppAgent(targetAgentUserId))) return null;
  return "An app's changes are governed by its owner: an agent credential cannot change how they land. Use the app's page.";
}

/**
 * The origin a pod app's webhooks may be sent to: its own site (the origin of
 * its metadata-document URL, the origin its redirect_uris must be on too).
 * `null` when the agent is not a pod app's.
 */
export async function podAppWebhookOrigin(
  agentUserId: string
): Promise<string | null> {
  const [row] = await db
    .select({ clientId: apps.oauthClientId })
    .from(apps)
    .where(and(eq(apps.agentUserId, agentUserId), eq(apps.mode, "oauth")))
    .limit(1);
  if (!row?.clientId) return null;
  try {
    return new URL(row.clientId).origin;
  } catch {
    return null;
  }
}
