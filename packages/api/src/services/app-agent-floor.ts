/**
 * Two small reads about an app's own agent (spec 17 PB4), kept apart from
 * `app-connect.ts` so the generic doors that need them (agent governance,
 * webhooks) do not pull the whole App Connect service into their import
 * graph. Only `db`, the request grant and the `apps` table.
 */

import {
  db,
  eq,
  and,
  getRequestGrant,
  isFullAccessGrant,
} from "@synap/database";
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
 * its owner's choice (`setAppWriteMode`, the app's page), so the credentials
 * that door refuses may not change the rules of an app's agent here either
 * (`PATCH /agent-users/:id/governance`, `agentUsers.update`,
 * `governanceRules.create|revoke`):
 *  - an AGENT's credential — acting for the owner, it passes those doors'
 *    "creator" check as the owner;
 *  - a SCOPED key — above all a person's "Sign in with Synap" token
 *    (`app_person`), which is the owner within one app's grant: it must not
 *    switch that app's own AI to "apply automatically" (I4, F6).
 * `caller` is the door's own caller context (tRPC `ctx`, Hub `c.get`).
 * Returns the refusal, or null.
 */
export async function appAgentGovernanceDenial(
  targetAgentUserId: string | null | undefined,
  caller: { agentUserId?: string | null; keyType?: string | null }
): Promise<string | null> {
  if (!targetAgentUserId) return null;
  const agent = isAgentCaller(caller);
  const grant = agent ? null : getRequestGrant();
  const scoped = !!grant && !isFullAccessGrant(grant);
  if (!agent && !scoped) return null;
  if (!(await isAppAgent(targetAgentUserId))) return null;
  return agent
    ? "An app's changes are governed by its owner: an agent credential cannot change how they land. Use the app's page."
    : "An app's changes are governed by its owner: a scoped key (an app sign-in included) cannot change how they land. Use the app's page, signed in as yourself.";
}

/**
 * The origin a pod app's webhooks may be sent to: its own site (the origin of
 * its metadata-document URL, the origin its redirect_uris must be on too).
 * The caller is a pod app when its key is held by the app's agent (a token
 * minted before 12 Nov 2026) OR when its grant names a pod app connection
 * (`KeyGrant.clientId` = the connection's public id): since 12 Nov every pod
 * app's token is the PERSON's (`app_person`, app-person-token.ts), so it
 * carries no agent and only its grant says which app is calling. `null` when
 * the caller is no pod app's.
 */
export async function podAppWebhookOrigin(caller: {
  agentUserId?: string | null;
  /** The request grant's app (`getRequestGrant()?.clientId`). */
  appPublicId?: string | null;
}): Promise<string | null> {
  const which = caller.agentUserId
    ? eq(apps.agentUserId, caller.agentUserId)
    : caller.appPublicId
      ? eq(apps.publicId, caller.appPublicId)
      : null;
  if (!which) return null;
  const [row] = await db
    .select({ clientId: apps.oauthClientId })
    .from(apps)
    .where(and(which, eq(apps.mode, "oauth")))
    .limit(1);
  if (!row?.clientId) return null;
  try {
    return new URL(row.clientId).origin;
  } catch {
    return null;
  }
}
