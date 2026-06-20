/**
 * Vault Reference Resolver
 *
 * Resolves `vault://secret-id` references in configuration objects.
 * Used by automation execution engine, MCP server env injection,
 * and webhook output configs.
 *
 * Only server-encrypted secrets (encryptionMode='server') can be resolved.
 * Client-encrypted secrets require user's master password and cannot be
 * resolved server-side — they will be left as-is with a warning.
 *
 * Usage:
 *   const resolved = await resolveVaultReferences(envVars, userId);
 *   // { API_KEY: "sk-live-..." } instead of { API_KEY: "vault://abc-123" }
 */

import { eq, and, sql as drizzleSql } from "drizzle-orm";
import { getDb } from "../client-pg.js";
import { secrets, vaultGrants } from "../schema/index.js";
import {
  decryptServerSide,
  decryptConfig,
  encryptConfig,
  isServerVaultAvailable,
} from "./server-vault.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "vault-resolver" });

/** Pattern: vault://secret-uuid or vault://secret-uuid/field-name */
const VAULT_REF_PATTERN = /^vault:\/\/([0-9a-f-]{36})(?:\/(.+))?$/;

/**
 * Check if a string is a vault reference.
 */
export function isVaultReference(value: string): boolean {
  return VAULT_REF_PATTERN.test(value);
}

/**
 * Parse a vault reference string.
 * Returns null if the string is not a valid vault reference.
 */
export function parseVaultReference(
  value: string
): { secretId: string; fieldName?: string } | null {
  const match = value.match(VAULT_REF_PATTERN);
  if (!match) return null;
  return {
    secretId: match[1],
    fieldName: match[2] || undefined,
  };
}

/** Reason an agent/IS redemption was refused at the grant gate. */
export type GrantDenialCode =
  | "no_grant"
  | "grant_expired"
  | "grant_revoked"
  | "grant_exhausted";

/** Thrown by resolveVaultSecret when requireGrant is set and no active grant exists. */
export class VaultGrantError extends Error {
  readonly code: GrantDenialCode;
  constructor(code: GrantDenialCode, message?: string) {
    super(message ?? code);
    this.name = "VaultGrantError";
    this.code = code;
  }
}

/** Thrown by assertGrantScoped when a grant would be a fully-wildcard secret read. */
export class UnscopedVaultGrantError extends Error {
  constructor() {
    super(
      "A vault grant must be scoped to a user and/or a workspace; " +
        "fully-wildcard grants (both grantedTo and workspaceId null) are not allowed."
    );
    this.name = "UnscopedVaultGrantError";
  }
}

/**
 * FIREWALL — issuance-time guard against fully-wildcard vault grants.
 *
 * At redemption (`findRedeemableGrant`), a NULL `granted_to` and a NULL
 * `workspace_id` each act as a WILDCARD: the row matches ANY redeemer principal.
 * A grant with BOTH null is therefore a pod-wide, any-actor secret read — any
 * agent reaching `/vault/redeem` (via `secrets.get(ref)`) could redeem the
 * secret, regardless of owner scope. That is a cross-user secret-read footgun.
 *
 * This is the CANONICAL guard: call it at EVERY site that inserts into
 * `vault_grants`, immediately before the insert, so a future second issuance
 * path can't accidentally mint an unscoped grant. It throws
 * `UnscopedVaultGrantError` when both binding columns are null; a grant scoped to
 * a user, a workspace, or both passes.
 *
 * This is prevention only — it does NOT alter redemption semantics or touch
 * existing rows.
 */
export function assertGrantScoped(grant: {
  grantedTo: string | null | undefined;
  workspaceId: string | null | undefined;
}): void {
  if (!grant.grantedTo && !grant.workspaceId) {
    throw new UnscopedVaultGrantError();
  }
}

/**
 * The principal redeeming a grant. Used to bind redemption to the grantee so a
 * grant issued to one agent/workspace cannot be redeemed by another principal
 * that merely happens to resolve for the same secret owner.
 *
 * - `agentUserId`: the specific agent identity the grant was issued to
 *   (matches vault_grants.granted_to). NULL on a grant means "any agent".
 * - `workspaceId`: the workspace the grant is scoped to
 *   (matches vault_grants.workspace_id). NULL on a grant means "any workspace".
 *
 * A NULL column on the grant is treated as a wildcard (unscoped grant); a
 * non-NULL column MUST equal the redeemer's corresponding value.
 */
export interface GrantRedeemer {
  agentUserId?: string | null;
  workspaceId?: string | null;
}

/**
 * Find the single best ACTIVE grant for a secret that the given redeemer is
 * entitled to redeem, WITHOUT consuming it. (Consumption happens later, only
 * after the secret successfully decrypts — see `incrementGrant` — so a decrypt
 * or missing-secret failure never burns a once-grant.)
 *
 * "Active" = revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
 * AND (max_uses IS NULL OR use_count < max_uses).
 *
 * Grantee binding: a grant is only a candidate when its granted_to / workspace_id
 * either is NULL (unscoped wildcard) or equals the redeemer's value. This makes
 * the granted_to / workspace_id columns enforcement-bearing (see schema comments
 * at secrets-vault.ts ~261-264), not just audit metadata.
 *
 * Ordering prefers the MOST-CONSTRAINED grant so single-use ('once') grants are
 * spent before broader ones:
 *   1. capped grants first              -> (max_uses IS NOT NULL) DESC
 *   2. then soonest expiry              -> expires_at ASC NULLS LAST
 *   3. then fewest remaining uses       -> (max_uses - use_count) ASC NULLS LAST
 *
 * Returns `{ ok: true, grantId }` with the chosen candidate, or `{ ok: false,
 * code }` with a specific denial reason (scoped to the same redeemer predicate)
 * for diagnostics.
 */
export async function findRedeemableGrant(
  secretId: string,
  redeemer: GrantRedeemer
): Promise<
  { ok: true; grantId: string } | { ok: false; code: GrantDenialCode }
> {
  const db = await getDb();
  const agentUserId = redeemer.agentUserId ?? null;
  const workspaceId = redeemer.workspaceId ?? null;

  // Read-only candidate find: most-constrained active grant for this redeemer.
  const candidate = await db.execute(drizzleSql`
    SELECT id FROM vault_grants
    WHERE secret_id = ${secretId}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_uses IS NULL OR use_count < max_uses)
      AND (granted_to IS NULL OR granted_to = ${agentUserId})
      AND (workspace_id IS NULL OR workspace_id = ${workspaceId})
    ORDER BY
      (max_uses IS NOT NULL) DESC,
      expires_at ASC NULLS LAST,
      (max_uses - use_count) ASC NULLS LAST
    LIMIT 1
  `);

  // postgres-js: db.execute returns a RowList (array-like) of result rows.
  const grantId = (candidate as unknown as Array<{ id: string }>)[0]?.id;
  if (grantId) return { ok: true, grantId };

  // No redeemable grant — classify why, scoped to the SAME redeemer predicate so
  // we don't misreport based on a grant this principal could never redeem. We
  // pick the newest matching grant and report its specific failure reason.
  const any = await db.query.vaultGrants.findFirst({
    where: and(
      eq(vaultGrants.secretId, secretId),
      drizzleSql`(${vaultGrants.grantedTo} IS NULL OR ${vaultGrants.grantedTo} = ${agentUserId})`,
      drizzleSql`(${vaultGrants.workspaceId} IS NULL OR ${vaultGrants.workspaceId} = ${workspaceId})`
    ),
    columns: {
      revokedAt: true,
      expiresAt: true,
      maxUses: true,
      useCount: true,
    },
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  if (!any) return { ok: false, code: "no_grant" };
  if (any.revokedAt) return { ok: false, code: "grant_revoked" };
  if (any.expiresAt && any.expiresAt.getTime() <= Date.now())
    return { ok: false, code: "grant_expired" };
  if (any.maxUses != null && any.useCount >= any.maxUses)
    return { ok: false, code: "grant_exhausted" };
  return { ok: false, code: "no_grant" };
}

/**
 * Atomically consume ONE use of a specific grant by id, guarded by the active
 * predicate. This is the serialization point that prevents over-redemption of a
 * capped grant under concurrency: the guarded UPDATE only succeeds for the
 * caller that wins the race in the window between candidate-find and increment.
 *
 * Returns true if this call consumed the use; false if the grant was revoked,
 * expired, or already exhausted by a concurrent redeemer (lost race).
 */
export async function incrementGrant(grantId: string): Promise<boolean> {
  const db = await getDb();
  const updated = await db.execute(drizzleSql`
    UPDATE vault_grants
    SET use_count = use_count + 1
    WHERE id = ${grantId}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_uses IS NULL OR use_count < max_uses)
    RETURNING id
  `);
  return (updated as unknown as Array<{ id: string }>).length > 0;
}

/**
 * Resolve a single vault reference to its plaintext value.
 *
 * @param secretId - UUID of the secret
 * @param userId - Owner of the secret (for access control)
 * @param fieldName - Optional JSON field within the decrypted data
 * @param opts.requireGrant - When true, enforce AI access grant semantics: an
 *   ACTIVE vault_grants row redeemable by `opts.redeemer` must exist for the
 *   secret, and one use is consumed ONLY AFTER the secret successfully decrypts
 *   (so a decrypt/missing-secret failure never burns a once-grant). Set ONLY by
 *   agent/IS redemption paths. Throws VaultGrantError if no redeemable grant
 *   exists. Internal/service redemption paths leave this unset.
 * @param opts.redeemer - The principal redeeming the grant (see GrantRedeemer).
 *   Binds redemption to the grantee so a grant issued to one agent/workspace is
 *   not redeemable by another. Required in practice whenever requireGrant is set.
 * @returns Resolved plaintext value, or null if unresolvable
 */
export async function resolveVaultSecret(
  secretId: string,
  userId: string,
  fieldName?: string,
  opts?: { requireGrant?: boolean; redeemer?: GrantRedeemer }
): Promise<string | null> {
  if (!isServerVaultAvailable()) {
    logger.warn("VAULT_SERVER_KEY not configured — cannot resolve vault refs");
    return null;
  }

  // FIX 2: when this is an agent/IS path, find a redeemable grant BEFORE
  // decrypting (throws if none) but DEFER the consuming increment until after a
  // successful decrypt, so a decrypt/missing-secret failure cannot burn a grant.
  let pendingGrantId: string | null = null;
  if (opts?.requireGrant) {
    const grant = await findRedeemableGrant(secretId, opts.redeemer ?? {});
    if (!grant.ok) {
      logger.warn({ secretId, code: grant.code }, "Vault grant check failed");
      throw new VaultGrantError(grant.code);
    }
    pendingGrantId = grant.grantId;
  }

  const db = await getDb();
  const secret = await db.query.secrets.findFirst({
    where: and(eq(secrets.id, secretId), eq(secrets.userId, userId)),
    columns: {
      id: true,
      encryptedData: true,
      iv: true,
      authTag: true,
      encryptionMode: true,
      deletedAt: true,
    },
  });

  if (!secret) {
    logger.warn({ secretId, userId }, "Vault secret not found");
    return null;
  }

  if (secret.deletedAt) {
    logger.warn({ secretId }, "Vault secret has been deleted");
    return null;
  }

  if (secret.encryptionMode === "client") {
    logger.warn(
      { secretId },
      "Cannot resolve client-encrypted secret server-side — requires user master password"
    );
    return null;
  }

  let plaintext: string;
  try {
    plaintext = decryptServerSide({
      encryptedData: secret.encryptedData!,
      iv: secret.iv!,
      authTag: secret.authTag!,
    });
  } catch (err) {
    logger.error({ err, secretId }, "Failed to decrypt vault secret");
    return null;
  }

  // Decrypt succeeded — NOW consume the grant. The guarded increment is the
  // serialization point that prevents over-redemption of a capped grant under
  // concurrency; if we lost the race in the window, the grant is exhausted.
  if (pendingGrantId) {
    const consumed = await incrementGrant(pendingGrantId);
    if (!consumed) {
      logger.warn(
        { secretId, grantId: pendingGrantId },
        "Vault grant exhausted in redemption window"
      );
      throw new VaultGrantError("grant_exhausted");
    }
    logger.info(
      { secretId, grantId: pendingGrantId },
      "Vault grant consumed for agent/IS redemption"
    );
  }

  // If a field name is specified, parse as JSON and extract
  if (fieldName) {
    try {
      const data = JSON.parse(plaintext) as Record<string, unknown>;
      const value = data[fieldName];
      return value != null ? String(value) : null;
    } catch {
      // Not JSON — return full plaintext if no field specified
      logger.warn(
        { secretId, fieldName },
        "Secret data is not JSON, cannot extract field"
      );
      return null;
    }
  }

  return plaintext;
}

/**
 * Resolve all vault references in a key-value config object.
 * Non-vault values are passed through unchanged.
 * Unresolvable references are replaced with empty string + warning logged.
 *
 * SECURITY: This path is INTENTIONALLY ungated — it does NOT enforce grant
 * semantics (no requireGrant) because it serves the service/automation bootstrap
 * path (e.g. injecting env vars into automation/MCP/webhook execution). It must
 * therefore NEVER be called with agent-controlled `config` or secretIds. Callers
 * that redeem on behalf of an agent must use resolveVaultSecret({ requireGrant,
 * redeemer }) instead so the grant gate runs.
 *
 * @param config - Key-value pairs that may contain vault:// references
 * @param userId - Owner for access control
 * @returns New object with all vault references resolved
 */
export async function resolveVaultReferences(
  config: Record<string, string>,
  userId: string
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(config)) {
    const ref = parseVaultReference(value);
    if (ref) {
      const secret = await resolveVaultSecret(
        ref.secretId,
        userId,
        ref.fieldName
      );
      if (secret !== null) {
        resolved[key] = secret;
      } else {
        logger.warn(
          { key, secretId: ref.secretId },
          "Could not resolve vault reference — using empty string"
        );
        resolved[key] = "";
      }
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * Resolve a service credential secret by serviceId.
 * Returns the decrypted JSON config for the service, or null if not found.
 * Only works for server-encrypted secrets (encryptionMode='server').
 */
export async function getServiceSecret(
  serviceId: string,
  userId: string
): Promise<Record<string, string> | null> {
  if (!isServerVaultAvailable()) return null;

  const db = await getDb();
  const secret = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.userId, userId),
      eq(secrets.serviceId, serviceId),
      eq(secrets.encryptionMode, "server")
    ),
    columns: {
      id: true,
      encryptedData: true,
      iv: true,
      authTag: true,
      deletedAt: true,
    },
  });

  if (!secret || secret.deletedAt) return null;

  try {
    return decryptConfig({
      encryptedData: secret.encryptedData!,
      iv: secret.iv!,
      authTag: secret.authTag!,
    });
  } catch {
    return null;
  }
}

/**
 * Store or update a service credential in the vault (server-encrypted).
 * Creates if not exists, updates if serviceId already exists for this user.
 */
export async function upsertServiceSecret(
  serviceId: string,
  userId: string,
  name: string,
  config: Record<string, string>
): Promise<string> {
  const blob = encryptConfig(config);
  const db = await getDb();

  const existing = await db.query.secrets.findFirst({
    where: and(eq(secrets.userId, userId), eq(secrets.serviceId, serviceId)),
    columns: { id: true },
  });

  if (existing) {
    await db
      .update(secrets)
      .set({
        encryptedData: blob.encryptedData,
        iv: blob.iv,
        authTag: blob.authTag,
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existing.id));
    return existing.id;
  }

  const [row] = await db
    .insert(secrets)
    .values({
      userId,
      name,
      type: "api_key",
      serviceId,
      encryptionMode: "server",
      encryptedData: blob.encryptedData,
      iv: blob.iv,
      authTag: blob.authTag,
    })
    .returning({ id: secrets.id });
  return row.id;
}
