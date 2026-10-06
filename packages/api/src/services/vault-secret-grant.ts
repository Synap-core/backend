/**
 * The ONE write of a direct vault redeem grant — shared by the direct door
 * (`hub-protocol/rest/vault.ts` POST /vault/secrets/:id/grant, human owner) and
 * its approval half (`vault/grant` executor, after a human approved an agent's
 * request). Keeping one function means the approved grant is byte-for-byte the
 * grant the owner would have made directly.
 */

import { db, and, eq, isNull } from "@synap/database";
import { vaultGrants } from "@synap/database/schema";

export type VaultSecretGrantScope = "once" | "session" | "permanent";

export interface VaultSecretGrantInput {
  secretId: string;
  grantedTo: string | null;
  workspaceId: string | null;
  scope: VaultSecretGrantScope;
  /** Session TTL in minutes (scope 'session' only; default 60). */
  ttlMinutes?: number | null;
  createdBy: string;
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
  if (reused) return reused;

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
