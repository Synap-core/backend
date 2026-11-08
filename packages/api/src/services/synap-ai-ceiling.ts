/**
 * Synap AI as a connected agent (spec: pod document aaa01184): the standing grant a person gave their own AI.
 *
 * The person's personal agent (`ensurePersonalAgentUser`, one per person, pod-wide) IS Synap AI. What it may do is a grant
 * the person approved once: grants with `client_id = "synap-ai"` on a pod-held key of that agent. A turn whose delegation
 * names that agent (`act.sub`) is bounded by it, never by full authority; an app's own grant can only narrow it further.
 *
 * Fail closed, never open:
 *  - no ceiling configured: `none`, and the caller keeps today's behaviour (an app's claim, else the delegation grant);
 *  - the agent is not the operator's personal agent: `not-applicable` (a persona, a computer agent: unchanged);
 *  - a paused agent: `refused` (pausing means the AI does nothing for anyone);
 *  - a ceiling that exists is the whole authority: a read that fails THROWS, it never reads as "none".
 */
import { and, db, eq, gt, isNull, or, type KeyGrant } from "@synap/database";
import { apiKeys, grants as grantRows, users } from "@synap/database/schema";
import { meetScope } from "@synap-core/types/grants";

/** The `grants.client_id` of the standing grant. Attribution, and what tells it from the agent's other keys' grants. */
export const SYNAP_AI_CLIENT_ID = "synap-ai";

export type SynapAiCeiling =
  | { status: "none" }
  | { status: "not-applicable" }
  | { status: "refused"; reason: "paused" }
  | { status: "ok"; grant: KeyGrant };

/** The agent a delegation names, as the operator's Synap AI: its ceiling, nothing, or a refusal. */
export async function resolveSynapAiCeiling(
  operatorUserId: string,
  agentUserId: string
): Promise<SynapAiCeiling> {
  const [agent] = await db
    .select({
      id: users.id,
      createdBy: users.createdByUserId,
      personal: users.isPersonalAgent,
      pausedAt: users.agentPausedAt,
    })
    .from(users)
    .where(and(eq(users.id, agentUserId), eq(users.userType, "agent")))
    .limit(1);
  // Any other agent (a persona, an agent on a computer, a stranger's) keeps today's behaviour.
  if (!agent || !agent.personal || agent.createdBy !== operatorUserId)
    return { status: "not-applicable" };
  if (agent.pausedAt) return { status: "refused", reason: "paused" };

  const now = new Date();
  const rows = await db
    .select({
      permissions: grantRows.permissions,
      workspaceIds: grantRows.workspaceIds,
      projectIds: grantRows.projectIds,
      entityIds: grantRows.entityIds,
    })
    .from(grantRows)
    .innerJoin(apiKeys, eq(apiKeys.id, grantRows.apiKeyId))
    .where(
      and(
        eq(grantRows.principalUserId, agentUserId),
        eq(grantRows.clientId, SYNAP_AI_CLIENT_ID),
        isNull(grantRows.revokedAt),
        or(isNull(grantRows.expiresAt), gt(grantRows.expiresAt, now)),
        eq(apiKeys.isActive, true)
      )
    );
  const scopes = rows.filter((r) => r.permissions.length > 0);
  if (scopes.length === 0) return { status: "none" };
  return {
    status: "ok",
    grant: {
      scopes: scopes.map((r) => ({
        permissions: [...r.permissions],
        workspaceIds: r.workspaceIds ? [...r.workspaceIds] : null,
        projectIds: r.projectIds ? [...r.projectIds] : null,
        entityIds: r.entityIds ? [...r.entityIds] : null,
      })),
      clientId: SYNAP_AI_CLIENT_ID,
    },
  };
}

/** What the agent AND the app both permit: one scope per overlap, never wider than either. No overlap = may touch nothing. */
export function narrowedByApp(
  ceiling: KeyGrant,
  app: KeyGrant | null
): KeyGrant {
  if (!app) return ceiling;
  const scopes = ceiling.scopes.flatMap((a) =>
    app.scopes.flatMap((b) => {
      const m = meetScope(a, b);
      return m
        ? [
            {
              permissions: m.permissions,
              workspaceIds: m.workspaceIds,
              projectIds: m.projectIds,
              entityIds: m.entityIds,
            },
          ]
        : [];
    })
  );
  // The app that asked is the client the turn acts as (an app's outward verbs always propose).
  const clientId = app.clientId ?? ceiling.clientId;
  return {
    scopes:
      scopes.length > 0
        ? scopes
        : [
            {
              permissions: [],
              workspaceIds: null,
              projectIds: null,
              entityIds: null,
            },
          ],
    clientId,
  };
}
