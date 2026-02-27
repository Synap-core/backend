/**
 * Service Key Crypto
 *
 * Server-side AES-256-GCM encryption for intelligence service API keys.
 * Unlike the user-facing secrets vault (which uses per-user master passwords),
 * this uses a server-held key from the environment — suitable for system-level
 * credentials that the server manages transparently.
 *
 * Env var: SYNAP_SERVICE_ENCRYPTION_KEY (falls back to HUB_PROTOCOL_API_KEY)
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";

/** Derive a 32-byte AES key from the env-provided secret. */
function getEncryptionKey(): Buffer {
  const raw =
    process.env.SYNAP_SERVICE_ENCRYPTION_KEY ||
    process.env.HUB_PROTOCOL_API_KEY ||
    "";

  if (!raw) {
    throw new Error(
      "No encryption key available — set SYNAP_SERVICE_ENCRYPTION_KEY in env"
    );
  }

  return createHash("sha256").update(raw).digest();
}

interface EncryptedPayload {
  e: string; // base64 ciphertext
  i: string; // base64 IV
  t: string; // base64 authTag
}

/** Encrypt a plaintext service API key. Returns a JSON string for DB storage. */
export function encryptServiceKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // 96-bit nonce for GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    e: encrypted.toString("base64"),
    i: iv.toString("base64"),
    t: authTag.toString("base64"),
  };

  return JSON.stringify(payload);
}

/** Decrypt a service API key previously encrypted with encryptServiceKey. */
export function decryptServiceKey(ciphertext: string): string {
  const key = getEncryptionKey();
  const payload = JSON.parse(ciphertext) as EncryptedPayload;
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.i, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.t, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.e, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Check whether a stored api_key value is encrypted (JSON with e/i/t fields).
 * Plaintext keys from before encryption was added will return false.
 */
export function isEncryptedServiceKey(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Partial<EncryptedPayload>;
    return (
      typeof parsed.e === "string" &&
      typeof parsed.i === "string" &&
      typeof parsed.t === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the plaintext API key from a stored value — handles both encrypted
 * and legacy plaintext values transparently.
 */
export function resolveServiceKey(stored: string): string {
  if (isEncryptedServiceKey(stored)) {
    return decryptServiceKey(stored);
  }
  // Plaintext fallback (pre-encryption records)
  return stored;
}
