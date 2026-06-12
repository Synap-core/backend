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

/**
 * Atomically consume one use of an ACTIVE grant for a secret.
 *
 * "Active" = revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
 * AND (max_uses IS NULL OR use_count < max_uses). Increments use_count in the
 * same statement so concurrent redemptions cannot over-consume a capped grant.
 * If multiple active grants exist for the secret, any one suffices (the one with
 * the soonest expiry / lowest remaining uses is preferred so 'once' grants are
 * spent first).
 *
 * Returns `{ ok: true, grantId }` on success, or `{ ok: false, code }` with a
 * specific denial reason for diagnostics.
 */
export async function consumeGrant(
  secretId: string
): Promise<
  { ok: true; grantId: string } | { ok: false; code: GrantDenialCode }
> {
  const db = await getDb();

  // Single round-trip: pick the best active grant and bump use_count atomically.
  const updated = await db.execute(drizzleSql`
    UPDATE vault_grants
    SET use_count = use_count + 1
    WHERE id = (
      SELECT id FROM vault_grants
      WHERE secret_id = ${secretId}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND (max_uses IS NULL OR use_count < max_uses)
      ORDER BY expires_at ASC NULLS LAST, max_uses ASC NULLS LAST
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);

  // postgres-js: db.execute returns a RowList (array-like) of result rows.
  const grantId = (updated as unknown as Array<{ id: string }>)[0]?.id;
  if (grantId) return { ok: true, grantId };

  // No active grant consumed — classify why for the caller's error code.
  const any = await db.query.vaultGrants.findFirst({
    where: eq(vaultGrants.secretId, secretId),
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
 * Resolve a single vault reference to its plaintext value.
 *
 * @param secretId - UUID of the secret
 * @param userId - Owner of the secret (for access control)
 * @param fieldName - Optional JSON field within the decrypted data
 * @param opts.requireGrant - When true, enforce AI access grant semantics: an
 *   ACTIVE vault_grants row must exist for the secret and one use is consumed.
 *   Set ONLY by agent/IS redemption paths. Throws VaultGrantError if no active
 *   grant exists. Internal/service redemption paths leave this unset.
 * @returns Resolved plaintext value, or null if unresolvable
 */
export async function resolveVaultSecret(
  secretId: string,
  userId: string,
  fieldName?: string,
  opts?: { requireGrant?: boolean }
): Promise<string | null> {
  if (!isServerVaultAvailable()) {
    logger.warn("VAULT_SERVER_KEY not configured — cannot resolve vault refs");
    return null;
  }

  // Enforce grant semantics BEFORE decrypting when this is an agent/IS path.
  if (opts?.requireGrant) {
    const grant = await consumeGrant(secretId);
    if (!grant.ok) {
      logger.warn({ secretId, code: grant.code }, "Vault grant check failed");
      throw new VaultGrantError(grant.code);
    }
    logger.info(
      { secretId, grantId: grant.grantId },
      "Vault grant consumed for agent/IS redemption"
    );
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

  try {
    const plaintext = decryptServerSide({
      encryptedData: secret.encryptedData!,
      iv: secret.iv!,
      authTag: secret.authTag!,
    });

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
  } catch (err) {
    logger.error({ err, secretId }, "Failed to decrypt vault secret");
    return null;
  }
}

/**
 * Resolve all vault references in a key-value config object.
 * Non-vault values are passed through unchanged.
 * Unresolvable references are replaced with empty string + warning logged.
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
