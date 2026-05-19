/**
 * Server-Side Vault Encryption
 *
 * Encrypts/decrypts secrets using a server-managed key (VAULT_SERVER_KEY env var)
 * rather than the user's master password. Used for service bootstrap credentials
 * (Hub Protocol API keys, pod URLs, workspace IDs) that need to be readable
 * by the server — for example, when an intelligence service calls
 * intelligenceRegistry.getServiceConfig to pull its own config on startup.
 *
 * Security model:
 *   - Key: 32-byte hex in VAULT_SERVER_KEY env var (AES-256)
 *   - Algorithm: AES-256-GCM (same as client-side vault)
 *   - IV: 12 random bytes per encryption (never reused)
 *   - Auth tag: 16 bytes, prevents tampering
 *   - Plaintext never logged or stored; only the ciphertext reaches the DB
 *
 * Generates VAULT_SERVER_KEY:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "server-vault" });

function getServerKey(): Buffer {
  const hex = process.env.VAULT_SERVER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "VAULT_SERVER_KEY env var is required and must be a 64-char hex string (32 bytes). " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, "hex");
}

export interface ServerEncryptedBlob {
  encryptedData: string; // base64 ciphertext
  iv: string; // base64 12-byte IV
  authTag: string; // base64 16-byte GCM auth tag
}

/**
 * Encrypt a plaintext string with the server key.
 * Returns the same blob shape as the client-side vault (encryptedData, iv, authTag).
 */
export function encryptServerSide(plaintext: string): ServerEncryptedBlob {
  const key = getServerKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag().toString("base64");

  return {
    encryptedData: encrypted,
    iv: iv.toString("base64"),
    authTag,
  };
}

/**
 * Decrypt a server-encrypted blob.
 * Throws if the key is wrong or the data has been tampered with (GCM auth tag mismatch).
 */
export function decryptServerSide(blob: ServerEncryptedBlob): string {
  const key = getServerKey();
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
 * Encrypt a JSON-serialisable config object.
 */
export function encryptConfig(
  config: Record<string, string>
): ServerEncryptedBlob {
  return encryptServerSide(JSON.stringify(config));
}

/**
 * Decrypt and JSON-parse a config blob.
 * Returns null (with a warning) if decryption fails — avoids crashing the provisioning flow.
 */
export function decryptConfig(
  blob: ServerEncryptedBlob
): Record<string, string> | null {
  try {
    return JSON.parse(decryptServerSide(blob)) as Record<string, string>;
  } catch (err) {
    logger.warn({ err }, "Failed to decrypt server-side config blob");
    return null;
  }
}

/** True when VAULT_SERVER_KEY is configured and valid length. */
export function isServerVaultAvailable(): boolean {
  const hex = process.env.VAULT_SERVER_KEY;
  return !!hex && hex.length === 64;
}
