/**
 * Agent presence — "connected / last seen" (V1 gaps G3, G8).
 *
 * The signal already exists per KEY: every authenticated MCP and Hub call
 * stamps `api_keys.last_used_at` (`apiKeyService.recordKeyUse`, throttled to
 * one write per key per minute). The mint's own verification does NOT stamp it
 * (`external-registration.ts` introspects instead), so a key that was minted
 * and never used reads as never seen. This joins that onto the agent USER the
 * surfaces list: an agent's `lastSeenAt` is its most recent key use, and
 * `host` is the instance label of the key it was last seen on.
 *
 * Callers pass ids they already floored (the list doors); this adds no rows.
 * A failed read throws — "never seen" and "could not tell" are different facts.
 */

import { apiKeys, db, and, eq, inArray, isNull } from "@synap/database";

export interface AgentPresence {
  /** ISO — most recent authenticated call on any of the agent's keys; `null` = never. */
  lastSeenAt: string | null;
  /** Instance label (`api_keys.instance_id`) of the key last seen; `null` if none/unlabelled. */
  host: string | null;
  /** Live keys (active, not revoked, not expired) — 0 means the agent cannot connect. */
  activeKeys: number;
  /** Keys minted and still awaiting the person's approval (inactive, not revoked, not expired). */
  pendingKeys: number;
  /**
   * Keys that existed and can no longer authenticate (revoked or expired). The
   * evidence `resolveAgentMark` needs before it may say "Disconnected" — an
   * agent that never held a key is a different fact ("No key yet").
   */
  revokedKeys: number;
  /**
   * Ids of the keys awaiting approval (the `pendingKeys`). Read by
   * `agentUsers.list` to build the ONE approval door (`/approve-agents?keys=`).
   */
  pendingKeyIds: string[];
}

export const NEVER_SEEN: Readonly<AgentPresence> = {
  lastSeenAt: null,
  host: null,
  activeKeys: 0,
  pendingKeys: 0,
  revokedKeys: 0,
  pendingKeyIds: [],
};

const neverSeen = (): AgentPresence => ({ ...NEVER_SEEN, pendingKeyIds: [] });

export async function loadAgentPresence(
  agentUserIds: readonly string[],
  now: Date = new Date()
): Promise<Map<string, AgentPresence>> {
  const out = new Map<string, AgentPresence>();
  const ids = [...new Set(agentUserIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      lastUsedAt: apiKeys.lastUsedAt,
      instanceId: apiKeys.instanceId,
      isActive: apiKeys.isActive,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(
      and(inArray(apiKeys.userId, ids), eq(apiKeys.keyType, "hub_inbound"))
    );
  for (const r of rows) {
    const cur = out.get(r.userId) ?? neverSeen();
    if (r.lastUsedAt) {
      const at = r.lastUsedAt.toISOString();
      if (!cur.lastSeenAt || at > cur.lastSeenAt) {
        cur.lastSeenAt = at;
        cur.host = r.instanceId ?? null;
      }
    }
    // An expired key cannot authenticate: it is neither live nor approvable.
    const expired = r.expiresAt !== null && r.expiresAt <= now;
    if (!r.revokedAt && !expired) {
      if (r.isActive) cur.activeKeys += 1;
      else {
        cur.pendingKeys += 1;
        cur.pendingKeyIds.push(r.id);
      }
    } else {
      cur.revokedKeys += 1;
    }
    out.set(r.userId, cur);
  }
  return out;
}

/**
 * The agents (among `agentUserIds`) that `viewerId` OPERATES: at least one
 * unrevoked hub key of the agent acts on behalf of the viewer
 * (`api_keys.linked_user_id`). That link is what makes the agent's calls run
 * AS the viewer — so it is exactly the set whose orient can see the viewer's
 * sessions. Another person's agent is visible on a shared roster but never
 * reads your work. A failed read throws.
 */
export async function agentsOperatedBy(
  viewerId: string,
  agentUserIds: readonly string[]
): Promise<Set<string>> {
  const ids = [...new Set(agentUserIds)].filter(Boolean);
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(
      and(
        inArray(apiKeys.userId, ids),
        eq(apiKeys.keyType, "hub_inbound"),
        eq(apiKeys.linkedUserId, viewerId),
        isNull(apiKeys.revokedAt)
      )
    );
  return new Set(rows.map((r) => r.userId));
}

/** Spread presence onto rows that carry an agent user `id`. */
export async function withAgentPresence<T extends { id: string }>(
  rows: T[]
): Promise<Array<T & AgentPresence>> {
  const presence = await loadAgentPresence(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, ...(presence.get(r.id) ?? neverSeen()) }));
}
