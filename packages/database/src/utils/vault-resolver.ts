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

import { eq, and } from "drizzle-orm";
import { getDb } from "../client-pg.js";
import { secrets } from "../schema/index.js";
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

/**
 * Resolve a single vault reference to its plaintext value.
 *
 * @param secretId - UUID of the secret
 * @param userId - Owner of the secret (for access control)
 * @param fieldName - Optional JSON field within the decrypted data
 * @returns Resolved plaintext value, or null if unresolvable
 */
export async function resolveVaultSecret(
  secretId: string,
  userId: string,
  fieldName?: string
): Promise<string | null> {
  if (!isServerVaultAvailable()) {
    logger.warn("VAULT_SERVER_KEY not configured — cannot resolve vault refs");
    return null;
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
