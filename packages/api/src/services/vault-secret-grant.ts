/**
 * The ONE write of a direct vault redeem grant — shared by the direct door
 * (`hub-protocol/rest/vault.ts` POST /vault/secrets/:id/grant, human owner),
 * its approval half (`vault/grant` executor, after a human approved an agent's
 * request) and a secret handed over for an ask (`provide-secret-grant.ts`, the
 * session read for the agent that asked). Keeping one function means the approved grant is byte-for-byte the
 * grant the owner would have made directly.
 */

import {
  db,
  and,
  asc,
  drizzleSql,
  eq,
  gt,
  inArray,
  isNull,
  or,
} from "@synap/database";
import { vaultGrants } from "@synap/database/schema";
import { PROVIDE_SECRET_ONCE_MINUTES } from "@synap-core/types/ask";
import { assertFreshAuthentication } from "../utils/device-session.js";

export type VaultSecretGrantScope = "once" | "session" | "permanent";

export interface VaultSecretGrantInput {
  secretId: string;
  grantedTo: string | null;
  workspaceId: string | null;
  scope: VaultSecretGrantScope;
  /** Session TTL in minutes (scope 'session' only; default 60). */
  ttlMinutes?: number | null;
  createdBy: string;
  /**
   * Reuse only an identical PERMANENT grant. A caller that ties its grant to
   * something that ends (a session) writes its own instead of borrowing one
   * whose end is someone else's.
   */
  reusePermanentOnly?: boolean;
}

export interface VaultSecretGrantResult {
  grantId: string;
  scope: string;
  expiresAt: string | null;
  reused?: true;
}

/** An active grant on one secret, as {@link findActiveSecretGrants} reads it. */
export interface ActiveSecretGrant extends VaultSecretGrantResult {
  useCount: number;
}

/**
 * THE active grant predicate: identical in principal + workspace, on these
 * secrets, not revoked, not expired (in SQL), and, with `scope`, only of that
 * scope. With its ordering ({@link activeSecretGrantOrder}) it is the ONE
 * derivation of "the grant the agent already holds": the provide sheet's
 * "already can read it" (`standingGrantsFor`), the reuse of a hand-over and
 * its Take back all name the same grant, never one each (review a089b624
 * S6). With `scope`, a caller that reuses only a permanent grant finds it
 * even when a shorter one for the same agent sits beside it.
 */
function activeSecretGrantWhere(
  secretIds: readonly string[],
  grantedTo: string | null,
  workspaceId: string | null,
  scope: VaultSecretGrantScope | undefined
) {
  return and(
    eq(vaultGrants.grantableType, "secret"),
    inArray(vaultGrants.grantableId, [...secretIds]),
    grantedTo
      ? eq(vaultGrants.grantedTo, grantedTo)
      : isNull(vaultGrants.grantedTo),
    workspaceId
      ? eq(vaultGrants.workspaceId, workspaceId)
      : isNull(vaultGrants.workspaceId),
    isNull(vaultGrants.revokedAt),
    or(
      isNull(vaultGrants.expiresAt),
      gt(vaultGrants.expiresAt, drizzleSql`now()`)
    ),
    scope ? eq(vaultGrants.scope, scope) : undefined
  );
}

/** Where several grants qualify, the OLDEST is the one (`createdAt`, then id). */
function activeSecretGrantOrder() {
  return [asc(vaultGrants.createdAt), asc(vaultGrants.id)];
}

/**
 * The active grant on each of these secrets, by secret id: the batch form of
 * {@link findActiveSecretGrant}, under the same predicate and ordering.
 */
export async function findActiveSecretGrants(
  secretIds: readonly string[],
  grantedTo: string | null,
  workspaceId: string | null,
  opts?: { scope?: VaultSecretGrantScope }
): Promise<Map<string, ActiveSecretGrant>> {
  const out = new Map<string, ActiveSecretGrant>();
  if (secretIds.length === 0) return out;
  const rows = await db
    .select({
      id: vaultGrants.id,
      secretId: vaultGrants.grantableId,
      scope: vaultGrants.scope,
      expiresAt: vaultGrants.expiresAt,
      useCount: vaultGrants.useCount,
    })
    .from(vaultGrants)
    .where(
      activeSecretGrantWhere(secretIds, grantedTo, workspaceId, opts?.scope)
    )
    .orderBy(...activeSecretGrantOrder());
  for (const r of rows) {
    if (out.has(r.secretId)) continue;
    out.set(r.secretId, {
      grantId: r.id,
      scope: r.scope ?? "permanent",
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      useCount: r.useCount,
      reused: true,
    });
  }
  return out;
}

/** The active grant on ONE secret, if any (the predicate and ordering above). */
export async function findActiveSecretGrant(
  secretId: string,
  grantedTo: string | null,
  workspaceId: string | null,
  opts?: { scope?: VaultSecretGrantScope }
): Promise<VaultSecretGrantResult | null> {
  const existing = await db.query.vaultGrants.findFirst({
    where: activeSecretGrantWhere(
      [secretId],
      grantedTo,
      workspaceId,
      opts?.scope
    ),
    orderBy: activeSecretGrantOrder(),
    columns: { id: true, scope: true, expiresAt: true },
  });
  if (!existing) return null;
  return {
    grantId: existing.id,
    scope: existing.scope ?? "permanent",
    expiresAt: existing.expiresAt ? existing.expiresAt.toISOString() : null,
    reused: true,
  };
}

/** Insert the grant (or reuse an identical active one). */
export async function applyVaultSecretGrant(
  input: VaultSecretGrantInput
): Promise<VaultSecretGrantResult> {
  const reused = await findActiveSecretGrant(
    input.secretId,
    input.grantedTo,
    input.workspaceId,
    input.reusePermanentOnly ? { scope: "permanent" } : undefined
  );
  if (reused && (!input.reusePermanentOnly || reused.scope === "permanent")) {
    return reused;
  }
  // A new grant hands an agent a secret's VALUE: from a Synap app, only
  // shortly after a real sign-in (utils/device-session.ts).
  assertFreshAuthentication();

  const now = Date.now();
  let expiresAt: Date | null;
  let maxUses: number | null;
  if (input.scope === "once") {
    expiresAt = new Date(now + PROVIDE_SECRET_ONCE_MINUTES * 60 * 1000);
    maxUses = 1;
  } else if (input.scope === "permanent") {
    expiresAt = null;
    maxUses = null;
  } else {
    expiresAt = new Date(now + (input.ttlMinutes ?? 60) * 60 * 1000);
    maxUses = null;
  }

  const [grant] = await db
    .insert(vaultGrants)
    .values({
      grantableType: "secret",
      grantableId: input.secretId,
      execMode: "auto",
      grantedTo: input.grantedTo,
      workspaceId: input.workspaceId,
      scope: input.scope,
      expiresAt,
      maxUses,
      createdBy: input.createdBy,
    })
    .returning({ id: vaultGrants.id });

  return {
    grantId: grant.id,
    scope: input.scope,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

/**
 * Revoke one grant by id (idempotent). For a caller that wrote a grant and
 * must take it back because the act it belonged to was refused — the owner's
 * own revoke door (`secretsVault.revokeGrant`) applies the owner check first.
 */
export async function revokeVaultSecretGrant(grantId: string): Promise<void> {
  await db
    .update(vaultGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(vaultGrants.id, grantId), isNull(vaultGrants.revokedAt)));
}
