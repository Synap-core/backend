/**
 * ONE DOOR — API-key identity resolution.
 *
 * Every transport that authenticates an API key (tRPC api-key middleware, the
 * Hub Protocol REST auth middleware, the MCP HTTP handler) must derive the same
 * three identity facts the same way. Before this module the derivation was
 * copy-pasted at three sites as:
 *
 *     effectiveUserId = keyRecord.linkedUserId ?? keyRecord.userId
 *     agentUserId     = keyRecord.linkedUserId ? keyRecord.userId : undefined
 *
 * That conflated "has a linked human" (a DELEGATION fact) with "is an agent"
 * (the fact the governance membrane actually needs). The real is-agent signal is
 * `users.userType === 'agent'` of the KEY PRINCIPAL (`keyRecord.userId`) — NOT
 * `linkedUserId` (delegation), NOT `keyType` (unreliable; defaults to
 * `hub_inbound`). A pod-wide agent key (userType='agent', no linked human — not
 * yet mintable) is exactly the case the old remap got wrong: it would leave
 * `agentUserId` undefined and let the agent write UNGOVERNED as the operator.
 *
 * Derivation:
 *   - `isAgent`         = the key principal's `users.userType === 'agent'`.
 *   - `agentUserId`     = `isAgent ? keyRecord.userId : undefined`
 *                         (derived from is-agent, NEVER from linkedUserId).
 *   - `effectiveUserId` = `keyRecord.linkedUserId ?? keyRecord.userId`
 *                         (the human the agent acts for, else the key owner).
 *
 * Behavior-preserving for every EXISTING key class: today every key that has a
 * `linkedUserId` is an agent-userType principal, so `agentUserId` is identical to
 * the old expression; keys with no `linkedUserId` (human PATs, service creds)
 * have a non-agent principal, so `agentUserId` stays `undefined` — identical too.
 * Only the not-yet-mintable pod-wide agent changes (that is wave #1b).
 *
 * Costs ONE indexed PK lookup on `users` — `keyRecord` (a plain `api_keys` row)
 * does not carry the owner's `userType`.
 */

import { db, users, eq } from "@synap/database";
import type { ApiKeyRecord } from "@synap/database";

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
}

/**
 * Resolve the effective + agent identity for a validated API key.
 *
 * @param keyRecord - a validated `api_keys` row (only `userId` + `linkedUserId`
 *   are read; a `Pick` is accepted so unit tests can pass a minimal fixture).
 */
export async function resolveKeyIdentity(
  keyRecord: Pick<ApiKeyRecord, "userId" | "linkedUserId">
): Promise<ResolvedKeyIdentity> {
  const owner = await db.query.users.findFirst({
    where: eq(users.id, keyRecord.userId),
    columns: { userType: true },
  });
  const isAgent = owner?.userType === "agent";
  return {
    effectiveUserId: keyRecord.linkedUserId ?? keyRecord.userId,
    agentUserId: isAgent ? keyRecord.userId : undefined,
    isAgent,
  };
}
