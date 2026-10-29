/**
 * One key, as the Keys page's detail panel reads it (pod-admin floor at the
 * router, `apiKeys.adminKeyDetail`):
 *
 *   - what it MAY touch: its live grants — permissions in the grant grammar,
 *     the spaces / projects / objects they are pinned to, who they act for,
 *     until when (`grants`, the W1 table; a key with none touches nothing);
 *   - how much it was USED: calls per day and by client over the usage
 *     window, through the ONE usage read door (`readUsageForCaller`);
 *   - what it DID on the pod: the proposals it filed (B7 stamps the calling
 *     key on every proposal) and the sessions it worked in (a runner records
 *     the key it called with).
 *
 * Reads only; the key list (`adminListAll`) carries the key's own fields.
 */

import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  inArray,
  isNull,
} from "@synap/database";
import {
  apiKeys,
  focusSessions,
  grants,
  proposals,
  sessionRunners,
  users,
  workspaces,
} from "@synap/database/schema";
import { readUsageForCaller } from "./usage/read-usage.js";

/** How many of the key's latest proposals and sessions the panel lists. */
export const KEY_DETAIL_RECENT = 20;

export interface KeyDetail {
  grants: Array<{
    id: string;
    label: string | null;
    permissions: string[];
    /** null = no narrowing on that axis. */
    workspaces: Array<{ id: string; name: string | null }> | null;
    projectIds: string[] | null;
    entityIds: string[] | null;
    onBehalfOf: { id: string; name: string | null };
    clientId: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
  usage: {
    retentionDays: number;
    /** One row per day with calls, oldest first. */
    days: Array<{ day: string; calls: number; failed: number }>;
    clients: Array<{ client: string; calls: number }>;
  };
  proposals: Array<{
    id: string;
    proposalType: string;
    status: string;
    summary: string | null;
    createdAt: string;
  }>;
  sessions: Array<{
    id: string;
    title: string | null;
    harness: string;
    lastSeenAt: string;
  }>;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

/** null when the key does not exist. */
export async function readKeyDetail(
  keyId: string,
  callerUserId: string
): Promise<KeyDetail | null> {
  const [key] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  if (!key) return null;

  const [grantRows, byDay, byClient, filed, runs] = await Promise.all([
    db
      .select()
      .from(grants)
      .where(and(eq(grants.apiKeyId, keyId), isNull(grants.revokedAt)))
      .orderBy(desc(grants.createdAt)),
    readUsageForCaller(callerUserId, {
      since: "30d",
      groupBy: "day,outcome",
      apiKeyId: keyId,
      limit: 1000,
    }),
    readUsageForCaller(callerUserId, {
      since: "30d",
      groupBy: "client",
      apiKeyId: keyId,
      limit: 10,
    }),
    db
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        status: proposals.status,
        summary: drizzleSql<string | null>`${proposals.data}->>'summary'`,
        createdAt: proposals.createdAt,
      })
      .from(proposals)
      .where(eq(proposals.apiKeyId, keyId))
      .orderBy(desc(proposals.createdAt))
      .limit(KEY_DETAIL_RECENT),
    db
      .select({
        id: sessionRunners.sessionId,
        title: focusSessions.title,
        harness: sessionRunners.harness,
        lastSeenAt: sessionRunners.lastSeenAt,
      })
      .from(sessionRunners)
      .leftJoin(focusSessions, eq(focusSessions.id, sessionRunners.sessionId))
      .where(eq(sessionRunners.apiKeyId, keyId))
      .orderBy(desc(sessionRunners.lastSeenAt))
      .limit(KEY_DETAIL_RECENT),
  ]);

  // Names for the spaces the grants pin and the people they act for.
  const spaceIds = [...new Set(grantRows.flatMap((g) => g.workspaceIds ?? []))];
  const personIds = [...new Set(grantRows.map((g) => g.onBehalfOf))];
  const [spaceRows, personRows] = await Promise.all([
    spaceIds.length
      ? db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, spaceIds))
      : Promise.resolve([]),
    personIds.length
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, personIds))
      : Promise.resolve([]),
  ]);
  const spaceName = new Map(spaceRows.map((s) => [s.id, s.name]));
  const personName = new Map(personRows.map((p) => [p.id, p.name]));

  const days = new Map<string, { calls: number; failed: number }>();
  for (const g of byDay.groups) {
    if (!g.day) continue;
    const d = days.get(g.day) ?? { calls: 0, failed: 0 };
    d.calls += g.calls;
    if (g.outcome && g.outcome !== "2xx" && g.outcome !== "3xx")
      d.failed += g.calls;
    days.set(g.day, d);
  }

  // One row per session: a session worked through several conversations
  // keeps its latest.
  const seen = new Set<string>();
  const sessions: KeyDetail["sessions"] = [];
  for (const r of runs) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    sessions.push({
      id: r.id,
      title: r.title ?? null,
      harness: r.harness,
      lastSeenAt: iso(r.lastSeenAt)!,
    });
  }

  return {
    grants: grantRows.map((g) => ({
      id: g.id,
      label: g.label,
      permissions: g.permissions,
      workspaces: g.workspaceIds
        ? g.workspaceIds.map((id) => ({ id, name: spaceName.get(id) ?? null }))
        : null,
      projectIds: g.projectIds,
      entityIds: g.entityIds,
      onBehalfOf: {
        id: g.onBehalfOf,
        name: personName.get(g.onBehalfOf) ?? null,
      },
      clientId: g.clientId,
      expiresAt: iso(g.expiresAt),
      createdAt: iso(g.createdAt)!,
    })),
    usage: {
      retentionDays: byDay.retentionDays,
      days: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, d]) => ({ day, ...d })),
      clients: byClient.groups.map((g) => ({
        client: g.client ?? "unknown",
        calls: g.calls,
      })),
    },
    proposals: filed.map((p) => ({
      id: p.id,
      proposalType: p.proposalType,
      status: p.status,
      summary: p.summary,
      createdAt: iso(p.createdAt)!,
    })),
    sessions,
  };
}
