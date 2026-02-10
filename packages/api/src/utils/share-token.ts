/**
 * Share token utilities
 *
 * - generateShareToken: cryptographically secure random token
 * - hashToken: SHA-256 hash for storage (never store plain token)
 * - verifyToken: compare plain token against stored hash
 * - hashPassword / verifyPassword: for optional link password protection
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";

const TOKEN_BYTES = 32;
const HASH_ALGORITHM = "sha256";

/**
 * Generate a cryptographically secure share token (base64url)
 * Returned value is shown to user once; store only the hash.
 */
export function generateShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Hash a token for storage. Never store the plain token.
 */
export function hashToken(token: string): string {
  return createHash(HASH_ALGORITHM).update(token, "utf8").digest("hex");
}

/**
 * Verify a plain token against a stored hash.
 */
export function verifyToken(plainToken: string, storedHash: string): boolean {
  if (!storedHash) return false;
  const computed = hashToken(plainToken);
  if (computed.length !== storedHash.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(storedHash, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Hash a password for storage. Use bcrypt in production for passwords;
 * this is a simpler alternative for optional link passwords.
 */
export function hashPassword(password: string): string {
  return createHash(HASH_ALGORITHM).update(password, "utf8").digest("hex");
}

/**
 * Verify a password against a stored hash.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;
  const computed = hashPassword(password);
  if (computed.length !== storedHash.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(storedHash, "hex")
    );
  } catch {
    return false;
  }
}
