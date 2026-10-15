/**
 * The clients the pod's OWN OAuth authorization server registered (Path B:
 * claude.ai pointed straight at `https://<pod>/mcp`; `routers/oauth/*`), read
 * and cut off as a pod admin sees them — the service behind `oauthClients.*`.
 *
 * A registration (`oauth_clients`, RFC 7591) is public and unauthenticated —
 * anyone may register — so it reaches NOTHING. Reach is the key the token
 * endpoint mints after a person consents: an `api_keys` row held by the
 * `claude-web-direct` agent, linked to that person, carrying
 * `instance_id = oauth:<client_id>:<user_id>` (`oauthKeyInstanceId`). Clients
 * are read THROUGH those keys: who connected one, how many keys it holds, when
 * one was last used.
 *
 * Revoke = stop every key minted for the client (and their grants) and burn
 * any authorization code still waiting to be exchanged. The client row is
 * KEPT: deleting it would only make the next registration a new row (claude.ai
 * re-registers on demand) while erasing the record of what was cut off. A
 * revoked client reaches nothing until a person consents again — the same
 * human act that connected it the first time.
 *
 * Pod-wide and unfloored on purpose: the caller gates (pod admin only).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  sqlTemplate,
  GrantRepository,
} from "@synap/database";
import {
  apiKeys,
  oauthAuthorizationCodes,
  oauthClients,
  users,
} from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { auditLog } from "../utils/audit-log.js";
import {
  oauthClientInstancePrefix,
  parseOauthKeyInstanceId,
} from "../routers/oauth/config.js";

/** Keys whose `instance_id` starts with `prefix` (one client, or every client). */
const mintedWhere = (prefix: string) =>
  sqlTemplate`starts_with(${apiKeys.instanceId}, ${prefix})`;

/** One key minted for a client, as the console shows it — never the secret. */
export interface MintedKey {
  id: string;
  keyName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  usageCount: number;
  isActive: boolean;
  revokedAt: Date | null;
  expiresAt: Date | null;
  /** The person who consented (the key's `linked_user_id`). */
  personId: string;
}

/** Every key minted through the pod's OAuth server, grouped by client id (newest first). */
async function mintedKeysByClient(
  clientId?: string
): Promise<Map<string, MintedKey[]>> {
  const rows = await db
    .select({
      id: apiKeys.id,
      keyName: apiKeys.keyName,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      usageCount: apiKeys.usageCount,
      isActive: apiKeys.isActive,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      linkedUserId: apiKeys.linkedUserId,
      instanceId: apiKeys.instanceId,
    })
    .from(apiKeys)
    .where(mintedWhere(oauthClientInstancePrefix(clientId)));
  const out = new Map<string, MintedKey[]>();
  for (const { instanceId, linkedUserId, ...key } of rows) {
    const parsed = parseOauthKeyInstanceId(instanceId);
    if (!parsed) continue;
    const list = out.get(parsed.clientId) ?? [];
    list.push({ ...key, personId: linkedUserId ?? parsed.userId });
    out.set(parsed.clientId, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  return out;
}

/** `https://claude.ai/api/mcp/auth_callback` → `claude.ai`; unparsable URIs are skipped. */
export function redirectHosts(uris: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const uri of uris) {
    try {
      hosts.add(new URL(uri).host);
    } catch {
      // Registration only accepts https URIs; a malformed legacy row names no host.
    }
  }
  return [...hosts];
}

type ClientRow = typeof oauthClients.$inferSelect;

/** Clients + their keys + the people who connected them — one query for the people. */
async function shapeClients(
  clients: readonly ClientRow[],
  keysByClient: Map<string, MintedKey[]>
) {
  const personIds = [
    ...new Set(
      clients.flatMap((c) =>
        (keysByClient.get(c.clientId) ?? []).map((k) => k.personId)
      )
    ),
  ];
  const people =
    personIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, personIds))
      : [];
  const personById = new Map(people.map((p) => [p.id, p]));
  return clients.map((client) => {
    const keys = keysByClient.get(client.clientId) ?? [];
    const active = keys.filter((k) => k.isActive && !k.revokedAt);
    const lastUsedAt = keys.reduce<Date | null>(
      (latest, k) =>
        k.lastUsedAt && (!latest || k.lastUsedAt > latest)
          ? k.lastUsedAt
          : latest,
      null
    );
    const activePeople = new Set(active.map((k) => k.personId));
    return {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUris: client.redirectUris,
      redirectHosts: redirectHosts(client.redirectUris),
      scopes: client.scopes,
      createdAt: client.createdAt,
      mintedKeys: keys.length,
      activeKeys: active.length,
      lastUsedAt,
      /** Everyone who ever connected it; `active` = still holds a live key. */
      people: [...new Set(keys.map((k) => k.personId))].map((id) => ({
        id,
        name: personById.get(id)?.name ?? null,
        email: personById.get(id)?.email ?? null,
        active: activePeople.has(id),
      })),
      keys,
    };
  });
}

/**
 * Every client a person CONNECTED — minted at least one key for (newest
 * registration first). A registration nobody consented to reaches nothing and
 * is noise in an inventory; `includeUnused` lists it anyway.
 */
export async function listOauthClients(opts: { includeUnused?: boolean }) {
  const keysByClient = await mintedKeysByClient();
  const clients = await db.query.oauthClients.findMany({
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  const shown = opts.includeUnused
    ? clients
    : clients.filter((c) => keysByClient.has(c.clientId));
  return (await shapeClients(shown, keysByClient)).map(
    ({ keys: _keys, ...client }) => client
  );
}

/** One client with every key minted for it; NOT_FOUND when unregistered. */
export async function getOauthClient(clientId: string) {
  const client = await db.query.oauthClients.findFirst({
    where: eq(oauthClients.clientId, clientId),
  });
  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
  }
  const [shaped] = await shapeClients(
    [client],
    await mintedKeysByClient(client.clientId)
  );
  return shaped!;
}

/**
 * Cut a client off: burn every authorization code not yet exchanged (so a
 * consent already in flight cannot mint a fresh key after this returns), then
 * revoke every live key minted for it and their grants. The client row stays
 * (see the file header). Idempotent.
 */
export async function revokeOauthClient(args: {
  clientId: string;
  actorUserId: string;
}): Promise<{ clientId: string; revokedKeys: number }> {
  const client = await db.query.oauthClients.findFirst({
    where: eq(oauthClients.clientId, args.clientId),
    columns: { clientId: true, clientName: true },
  });
  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
  }
  const burned = await db
    .update(oauthAuthorizationCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationCodes.clientId, client.clientId),
        isNull(oauthAuthorizationCodes.consumedAt)
      )
    )
    .returning({ codeHash: oauthAuthorizationCodes.codeHash });
  const revoked = await revokeApiKeys(db, {
    where: and(
      mintedWhere(oauthClientInstancePrefix(client.clientId)),
      eq(apiKeys.isActive, true)
    ),
    revokedBy: args.actorUserId,
    reason: `OAuth client revoked: ${client.clientName}`,
  });
  const ids = revoked.map((k) => k.id);
  await new GrantRepository(db).revokeForKeys(ids, args.actorUserId);
  await auditLog({
    subjectType: "api_keys",
    action: "revoke",
    phase: "completed",
    subjectId: client.clientId,
    userId: args.actorUserId,
    workspaceId: null,
    data: {
      oauthClientId: client.clientId,
      clientName: client.clientName,
      revokedKeys: ids.length,
      burnedCodes: burned.length,
    },
  });
  return { clientId: client.clientId, revokedKeys: ids.length };
}
