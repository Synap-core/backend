/**
 * Vault Reference Resolver (Jobs Package)
 *
 * Lightweight copy of the API package's vault-resolver for use in
 * the automation executor. Resolves `vault://secret-id` and
 * `vault://secret-id/field-name` patterns in config objects.
 *
 * Only server-encrypted secrets (encryptionMode='server') can be resolved.
 * Requires VAULT_SERVER_KEY env var.
 */

import { createDecipheriv } from "crypto";
import { db, eq, and } from "@synap/database";
import { secrets } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "vault-resolver-jobs" });

const VAULT_REF_PATTERN = /^vault:\/\/([0-9a-f-]{36})(?:\/(.+))?$/;

function isVaultAvailable(): boolean {
  const key = process.env.VAULT_SERVER_KEY;
  return !!key && key.length === 64;
}

function decrypt(blob: {
  encryptedData: string;
  iv: string;
  authTag: string;
}): string {
  const key = Buffer.from(process.env.VAULT_SERVER_KEY!, "hex");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(blob.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(blob.authTag, "base64"));
  let decrypted = decipher.update(blob.encryptedData, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Check if a string is a vault reference.
 */
export function isVaultReference(value: string): boolean {
  return VAULT_REF_PATTERN.test(value);
}

/**
 * Resolve a single vault secret by ID.
 */
async function resolveSecret(
  secretId: string,
  userId: string,
  fieldName?: string
): Promise<string | null> {
  if (!isVaultAvailable()) {
    logger.warn("VAULT_SERVER_KEY not configured — cannot resolve vault refs");
    return null;
  }

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

  if (!secret || secret.deletedAt) return null;

  if (secret.encryptionMode === "client") {
    logger.warn(
      { secretId },
      "Cannot resolve client-encrypted secret server-side"
    );
    return null;
  }

  try {
    const plaintext = decrypt({
      encryptedData: secret.encryptedData!,
      iv: secret.iv!,
      authTag: secret.authTag!,
    });

    if (fieldName) {
      try {
        const data = JSON.parse(plaintext) as Record<string, unknown>;
        const value = data[fieldName];
        return value != null ? String(value) : null;
      } catch {
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
 * Resolve all vault:// references in a string-valued config object.
 * Non-vault values are passed through unchanged.
 */
export async function resolveVaultReferences(
  config: Record<string, string>,
  userId: string
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(config)) {
    const match = value.match(VAULT_REF_PATTERN);
    if (match) {
      const secretId = match[1];
      const fieldName = match[2] || undefined;
      const secret = await resolveSecret(secretId, userId, fieldName);
      resolved[key] = secret ?? "";
      if (!secret) {
        logger.warn(
          { key, secretId },
          "Could not resolve vault reference — using empty string"
        );
      }
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}
