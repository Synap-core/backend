/**
 * Synap AI as a connected agent (spec: pod document aaa01184): the standing grant a person gave their own AI.
 *
 * The person's personal agent (`ensurePersonalAgentUser`, one per person, pod-wide) IS Synap AI. What it may do is the grant
 * the person set ONCE, through the same door as every other agent's access (the Keys page, `apiKeys.setGrants`): the grants
 * on its pod-held key (`ensureSynapAiKey`: type `service`, instance `synap-ai`, a secret nobody ever sees, so it can never
 * authenticate a request; it only holds the grants). A turn whose delegation names that agent (`act.sub`) is bounded by
 * them, never by full authority; an app's own grant can only narrow them further.
 *
 * Fail closed, never open:
 *  - no ceiling configured: `none`. The hub keeps today's behaviour for it; the app chat door asks the person to connect;
 *  - the agent is not the operator's personal agent: `not-applicable` (a persona, a computer agent: unchanged);
 *  - a paused agent: `refused` (pausing means the AI does nothing for anyone);
 *  - a ceiling that exists is the whole authority: a read that fails THROWS, it never reads as "none".
 */
import { randomBytes } from "node:crypto";
import {
  and,
  ApiKeyRepository,
  asc,
  db,
  EventRepository,
  eq,
  gt,
  isNull,
  or,
  sql,
  type KeyGrant,
} from "@synap/database";
import { apiKeys, grants as grantRows, users } from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { meetScope } from "@synap-core/types/grants";
import { ensurePersonalAgentUser } from "../utils/personal-agent-user.js";
import { toPodAdminOrigin } from "../utils/pod-admin-origin.js";

/** The `client` a Synap AI turn acts as (attribution only; the grants themselves carry no client). */
export const SYNAP_AI_CLIENT_ID = "synap-ai";
/** What marks the agent's pod-held key (`api_keys.instance_id`); its `key_type` is the existing `service`. */
export const SYNAP_AI_KEY_INSTANCE = "synap-ai";

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
        eq(apiKeys.userId, agentUserId),
        eq(apiKeys.keyType, "service"),
        eq(apiKeys.instanceId, SYNAP_AI_KEY_INSTANCE),
        eq(apiKeys.isActive, true),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
        eq(grantRows.principalUserId, agentUserId),
        isNull(grantRows.revokedAt),
        or(isNull(grantRows.expiresAt), gt(grantRows.expiresAt, now))
      )
    );
  const scopes = rows.filter((r) => r.permissions.length > 0);
  if (scopes.length === 0) return { status: "none" };
  return {
    status: "ok",
    grant: {
      scopes: scopes.map((r) => ({
        permissions: [...r.permissions],
        workspaceIds: r.workspaceIds,
        projectIds: r.projectIds,
        entityIds: r.entityIds,
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

/**
 * The person's Synap AI and its pod-held key, created on first need (idempotent). The key exists so the person has ONE place
 * to say what Synap AI may read: the Keys page, where every agent's access is set. Its secret is generated here and never
 * stored in the clear nor shown: nothing can authenticate with it, it only carries the grants.
 */
export async function ensureSynapAiKey(
  operatorUserId: string
): Promise<{ agentUserId: string; keyId: string }> {
  const agentUserId = await ensurePersonalAgentUser(operatorUserId);
  const oldestHeld = async () =>
    (
      await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.userId, agentUserId),
            eq(apiKeys.keyType, "service"),
            eq(apiKeys.instanceId, SYNAP_AI_KEY_INSTANCE),
            eq(apiKeys.isActive, true),
            isNull(apiKeys.revokedAt)
          )
        )
        .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id))
        .limit(1)
    )[0];
  const held = await oldestHeld();
  if (held) return { agentUserId, keyId: held.id };
  const secret = `synap_ai_${randomBytes(32).toString("hex")}`;
  const key = await new ApiKeyRepository(db, new EventRepository(sql)).create(
    {
      keyName: "Synap AI",
      keyPrefix: secret.slice(0, 12),
      key: secret,
      scope: [],
      userId: agentUserId,
      linkedUserId: operatorUserId,
      keyType: "service",
      instanceId: SYNAP_AI_KEY_INSTANCE,
      description:
        "What your own Synap AI may read and do when you talk to it from an app. Set its access here.",
    },
    operatorUserId
  );
  // Nothing is unique on the held key, so two first turns racing each made one. Converge on the OLDEST, every racer the
  // same way, and retire ours: the person must never see two "Synap AI" rows where revoking one leaves the other's grants live.
  const winner = await oldestHeld();
  if (winner && winner.id !== key.id) {
    // The ONE revoke door (it also drops the verification cache, so the loser cannot validate for a TTL).
    await revokeApiKeys(db, {
      where: eq(apiKeys.id, key.id),
      revokedBy: operatorUserId,
      reason:
        "A second Synap AI key made by racing first turns; the oldest is kept",
    });
    return { agentUserId, keyId: winner.id };
  }
  return { agentUserId, keyId: key.id };
}

export type SynapAiGate =
  | { open: true }
  | {
      open: false;
      status: 409;
      body: {
        error: string;
        code: "SYNAP_AI_NOT_CONNECTED" | "SYNAP_AI_PAUSED";
        connectUrl: string | null;
      };
    };

/**
 * May an app's chat turn run for this person? Only through their connected Synap AI: it must have a grant (they set what it
 * may read, once). Not connected: the turn is refused BEFORE it starts, with the page where they connect it. Paused: refused.
 * `podOrigin` is the pod's own origin (the link is its console's Keys page).
 */
export async function synapAiGate(
  operatorUserId: string,
  podOrigin: string
): Promise<SynapAiGate> {
  const { agentUserId } = await ensureSynapAiKey(operatorUserId);
  const ceiling = await resolveSynapAiCeiling(operatorUserId, agentUserId);
  if (ceiling.status === "ok") return { open: true };
  let connectUrl: string | null = null;
  try {
    connectUrl = `${toPodAdminOrigin(podOrigin)}/keys`;
  } catch {
    connectUrl = null;
  }
  if (ceiling.status === "refused")
    return {
      open: false,
      status: 409,
      body: {
        error: "Synap AI is paused. Resume it to chat from an app.",
        code: "SYNAP_AI_PAUSED",
        connectUrl,
      },
    };
  return {
    open: false,
    status: 409,
    body: {
      error: "Connect Synap AI to chat from an app: choose what it may read.",
      code: "SYNAP_AI_NOT_CONNECTED",
      connectUrl,
    },
  };
}
