/**
 * Server-Side Vault Encryption — the door for server-mode vault secrets
 * (`secrets.encrypted_data` + `iv` + `auth_tag`, `encryptionMode='server'`):
 * service bootstrap credentials, connector tokens, user API keys that the
 * server must be able to read. A thin, named wrapper over the pod's
 * field-crypto core (`field-crypto.ts`, `@synap-core/field-crypto`): every
 * call names its cell (`{ column: "secrets.encrypted_data", rowId }`, the AAD).
 *
 * With `SYNAP_FIELD_KEYS` set, `encryptedData` holds a `senc:1:<kid>:…`
 * envelope and `iv`/`authTag` are empty strings. Until then the blob keeps the
 * pre-keyring shape (base64 AES-256-GCM under VAULT_SERVER_KEY), which stays
 * readable either way.
 */

import { createHmac } from "node:crypto";
import { createLogger } from "@synap-core/core";
import {
  parseVaultServerKey,
  podFieldCrypto,
  type FieldRef,
  type ServerEncryptedBlob,
} from "./field-crypto.js";
import type { BlobColumn } from "./encrypted-columns.js";

export type { ServerEncryptedBlob };

const logger = createLogger({ module: "server-vault" });

type VaultRef = FieldRef<BlobColumn>;

/** Encrypt a plaintext string for one server-mode vault row. */
export function encryptServerSide(
  plaintext: string,
  ref: VaultRef
): ServerEncryptedBlob {
  return podFieldCrypto().encryptBlob(plaintext, ref);
}

/**
 * Decrypt a server-mode vault blob. Throws on a wrong key, a value copied from
 * another row, or tampering.
 */
export function decryptServerSide(
  blob: ServerEncryptedBlob,
  ref: VaultRef
): string {
  return podFieldCrypto().decryptBlob(blob, ref);
}

/** Encrypt a JSON-serialisable config object for one vault row. */
export function encryptConfig(
  config: Record<string, string>,
  ref: VaultRef
): ServerEncryptedBlob {
  return encryptServerSide(JSON.stringify(config), ref);
}

/**
 * Decrypt and JSON-parse a config blob.
 * Returns null (with a warning) if decryption fails — avoids crashing the provisioning flow.
 */
export function decryptConfig(
  blob: ServerEncryptedBlob,
  ref: VaultRef
): Record<string, string> | null {
  try {
    return JSON.parse(decryptServerSide(blob, ref)) as Record<string, string>;
  } catch (err) {
    logger.warn(
      {
        rowId: ref.rowId,
        code: (err as { code?: string }).code ?? "ERROR",
      },
      "Failed to decrypt server-side config blob"
    );
    return null;
  }
}

/**
 * Keyed fingerprint of a password for server-side reused-password detection
 * (Watchtower BF-8). Returns HMAC-SHA256(VAULT_SERVER_KEY, normalize(password))
 * as lowercase hex — a deterministic digest so two secrets sharing a password
 * yield the same fingerprint, WITHOUT ever storing or re-deriving the plaintext.
 *
 * HMAC keyed by VAULT_SERVER_KEY (not a bare SHA-256) means the fingerprint
 * column alone is useless to an attacker: an offline dictionary attack is
 * impossible without the server key. Normalization (trim + lowercase) collapses
 * trivial whitespace/casing variants so they still count as "reused".
 *
 * This is a MAC, not field encryption: it stays on VAULT_SERVER_KEY (the
 * SYNAP_FIELD_KEYS ring rotates, a fingerprint must not), so that key cannot
 * leave the pod's env until fingerprints get their own key. Throws when it is
 * absent; returns null for an empty/whitespace-only password.
 */
export function fingerprintPassword(password: string): string | null {
  const normalized = password.trim().toLowerCase();
  if (!normalized) return null;
  const key = parseVaultServerKey(process.env.VAULT_SERVER_KEY);
  if (!key) {
    throw new Error(
      "VAULT_SERVER_KEY env var is required and must be a 64-char hex string (32 bytes)"
    );
  }
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex");
}

/**
 * True when the server vault can encrypt and decrypt: the SYNAP_FIELD_KEYS
 * ring is set, or VAULT_SERVER_KEY is a valid 64-hex key.
 */
export function isServerVaultAvailable(): boolean {
  return (
    !!process.env.SYNAP_FIELD_KEYS?.trim() ||
    parseVaultServerKey(process.env.VAULT_SERVER_KEY) !== null
  );
}
