/**
 * The ONE write of a direct vault redeem grant — shared by the direct door
 * (`hub-protocol/rest/vault.ts` POST /vault/secrets/:id/grant, human owner),
 * its approval half (`vault/grant` executor, after a human approved an agent's
 * request) and a secret handed over for an ask (`provide-secret-grant.ts`, the
 * session read for the agent that asked). Keeping one function means the approved grant is byte-for-byte the
 * grant the owner would have made directly.
 */

import { db, and, eq, isNull } from "@synap/database";
import { vaultGrants } from "@synap/database/schema";
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

/** An active grant identical in principal + workspace, if one exists. */
export async function findActiveSecretGrant(
  secretId: string,
  grantedTo: string | null,
  workspaceId: string | null
): Promise<VaultSecretGrantResult | null> {
  const existing = await db.query.vaultGrants.findFirst({
    where: and(
      eq(vaultGrants.grantableType, "secret"),
      eq(vaultGrants.grantableId, secretId),
      grantedTo
        ? eq(vaultGrants.grantedTo, grantedTo)
        : isNull(vaultGrants.grantedTo),
      workspaceId
        ? eq(vaultGrants.workspaceId, workspaceId)
        : isNull(vaultGrants.workspaceId),
      isNull(vaultGrants.revokedAt)
    ),
    columns: { id: true, scope: true, expiresAt: true },
  });
  if (!existing) return null;
  if (existing.expiresAt !== null && existing.expiresAt <= new Date())
    return null;
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
    input.workspaceId
  );
  if (reused && (!input.reusePermanentOnly || reused.scope === "permanent")) {
    return reused;
  }
  // A new grant hands an agent a secret's VALUE: from a Synap app, only
  // shortly after a real sign-in (utils/device-session.ts).

  const now = Date.now();
  let expiresAt: Date | null;
  let maxUses: number | null;
  if (input.scope === "once") {
    expiresAt = new Date(now + 15 * 60 * 1000);
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
