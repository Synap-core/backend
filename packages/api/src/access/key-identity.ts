/**
 * ONE DOOR — API-key identity resolution.
 *
 * Every transport that authenticates an API key (tRPC api-key middleware, the
 * Hub Protocol REST auth middleware, the MCP HTTP handler, the `/setup/agent`
 * surface-key path) must derive the same three identity facts the same way.
 * The real is-agent signal is `users.userType === 'agent'` of the KEY
 * PRINCIPAL (`keyRecord.userId`) — NOT `linkedUserId` (a DELEGATION fact —
 * which human the agent acts for), NOT `keyType` (unreliable; defaults to
 * `hub_inbound`). A pod-wide agent key (userType='agent', no linked human) is
 * exactly the case a `linkedUserId`-keyed derivation gets wrong: it would
 * read as "no agent" and let the key write, or mint, UNGOVERNED as if it were
 * human-owned.
 *
 * Derivation:
 *   - `isAgent`         = the key principal's `users.userType === 'agent'`.
 *   - `agentUserId`     = `isAgent ? keyRecord.userId : undefined`
 *                         (derived from is-agent, NEVER from linkedUserId).
 *   - `effectiveUserId` = `keyRecord.linkedUserId ?? keyRecord.userId`
 *                         (the human the agent acts for, else the key owner).
 *
 * Costs ONE indexed PK lookup on `users` — `keyRecord` (a plain `api_keys` row)
 * does not carry the owner's `userType`.
 *
 * APP KEYS are agent keys: an Application acts as its own agent user, linked
 * to its owner (`apps.agent_user_id`, 0313), so its writes run the agent
 * ladder. A key minted before 0313 is still held by the human; when one
 * authenticates (its grant names an app, `isAppPublicId`, and its holder is
 * not an agent) it is adopted onto the app's agent here, once, and resolves
 * as that agent from this request on. A failed adoption THROWS: answering
 * "human" would let the key write ungoverned.
 */

import { db, users, eq, GrantRepository, isAppPublicId } from "@synap/database";
import type { ApiKeyRecord, KeyGrant } from "@synap/database";

export interface ResolvedKeyIdentity {
  /** The identity that OWNS/SEES the data: the linked human, else the key owner. */
  effectiveUserId: string;
  /**
   * The acting agent principal, set ONLY when the key principal is an agent.
   * A defined value is what routes a write through `checkPermissionOrPropose`
   * into a reviewable proposal. `undefined` for human/service principals.
   */
  agentUserId: string | undefined;
  /** True iff the key principal (`keyRecord.userId`) has `userType === 'agent'`. */
  isAgent: boolean;
  /**
   * W1 — what this key may touch. `null` = a key that never had a grant
   * (legacy: scopes + the human floor). A revoked/expired grant is DENY-ALL,
   * never null. A failed grant read THROWS: guessing "no grant" would widen.
   *
   * APP ATTRIBUTION: this is also the carrier of the app identity — `KeyGrant
   * .clientId` (the app's `public_id`, i.e. `grants.client_id`) rides WITH the
   * grant. Every key-auth door enters it via `runWithGrant(grant, …)`, so
   * `getRequestGrant()?.clientId` is readable at write time and a governed write
   * can be stamped "via <app>" next to the connecting human. Attribution only —
   * it never widens what the grant permits.
   */
  grant: KeyGrant | null;
}

/**
 * Resolve the effective + agent identity for a validated API key.
 *
 * @param keyRecord - a validated `api_keys` row (`userId`, `linkedUserId`, and
 *   `id` for the grant; a `Pick` is accepted so unit tests can pass a minimal
 *   fixture — with no `id` there is no grant to load).
 */
export async function resolveKeyIdentity(
  keyRecord: Pick<ApiKeyRecord, "userId" | "linkedUserId"> & {
    id?: string;
  }
): Promise<ResolvedKeyIdentity> {
  const owner = await db.query.users.findFirst({
    where: eq(users.id, keyRecord.userId),
    columns: { userType: true },
  });
  const isAgent = owner?.userType === "agent";
  const grant = keyRecord.id
    ? await new GrantRepository(db).resolveForKey(keyRecord.id)
    : null;
  if (!isAgent && keyRecord.id && isAppPublicId(grant?.clientId)) {
    const { adoptLegacyAppKey } = await import("../services/app-connect.js");
    const appAgentUserId = await adoptLegacyAppKey({
      apiKeyId: keyRecord.id,
      keyOwnerUserId: keyRecord.userId,
      publicId: grant!.clientId!,
    });
    if (appAgentUserId) {
      return {
        effectiveUserId: keyRecord.userId,
        agentUserId: appAgentUserId,
        isAgent: true,
        grant,
      };
    }
  }
  return {
    effectiveUserId: keyRecord.linkedUserId ?? keyRecord.userId,
    agentUserId: isAgent ? keyRecord.userId : undefined,
    isAgent,
    grant,
  };
}
