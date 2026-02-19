/**
 * Encryption Service
 *
 * Provides encryption utilities for the Secrets Vault.
 * Note: Primary encryption happens CLIENT-SIDE. This service handles:
 * - Master password verification
 * - Key derivation parameter generation
 * - Server-side operations that don't expose secrets
 */

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { promisify } from "util";
import { scrypt } from "crypto";

const scryptAsync = promisify(scrypt);

// ============================================================================
// Configuration
// ============================================================================

export const ENCRYPTION_CONFIG = {
  // AES-256-GCM settings
  algorithm: "aes-256-gcm" as const,
  keyLength: 32, // 256 bits
  ivLength: 12, // 96 bits (recommended for GCM)
  tagLength: 16, // 128 bits

  // Key derivation settings (Argon2-like via scrypt)
  saltLength: 32, // 256 bits
  scryptParams: {
    N: 2 ** 17, // CPU/memory cost (131072)
    r: 8, // Block size
    p: 1, // Parallelism
    maxmem: 256 * 1024 * 1024, // 256 MB
  },

  // Verification value (encrypted to verify correct password)
  verificationPlaintext: "SYNAP_VAULT_VERIFICATION_2024",
};

// ============================================================================
// Types
// ============================================================================

export interface EncryptedData {
  ciphertext: string; // Base64 encoded
  iv: string; // Base64 encoded
  authTag: string; // Base64 encoded
}

export interface KeyDerivationParams {
  salt: string; // Base64 encoded
  algorithm: string;
  params: {
    N: number;
    r: number;
    p: number;
  };
}

export interface VaultKeySetup {
  keyDerivationParams: KeyDerivationParams;
  verification: EncryptedData;
}

// ============================================================================
// Encryption Service
// ============================================================================

export class EncryptionService {
  /**
   * Generate a random salt for key derivation
   */
  generateSalt(): string {
    return randomBytes(ENCRYPTION_CONFIG.saltLength).toString("base64");
  }

  /**
   * Generate a random IV for encryption
   */
  generateIv(): string {
    return randomBytes(ENCRYPTION_CONFIG.ivLength).toString("base64");
  }

  /**
   * Derive encryption key from master password using scrypt
   * This is computationally expensive by design (memory-hard)
   */
  async deriveKey(masterPassword: string, salt: string): Promise<Buffer> {
    const saltBuffer = Buffer.from(salt, "base64");
    const { N, r, p, maxmem } = ENCRYPTION_CONFIG.scryptParams;

    const key = (await scryptAsync(
      masterPassword,
      saltBuffer,
      ENCRYPTION_CONFIG.keyLength,
      {
        N,
        r,
        p,
        maxmem,
      }
    )) as Buffer;

    return key;
  }

  /**
   * Encrypt data with AES-256-GCM
   */
  encrypt(plaintext: string, key: Buffer): EncryptedData {
    const iv = randomBytes(ENCRYPTION_CONFIG.ivLength);
    const cipher = createCipheriv(ENCRYPTION_CONFIG.algorithm, key, iv, {
      authTagLength: ENCRYPTION_CONFIG.tagLength,
    });

    let ciphertext = cipher.update(plaintext, "utf8", "base64");
    ciphertext += cipher.final("base64");
    const authTag = cipher.getAuthTag();

    return {
      ciphertext,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
    };
  }

  /**
   * Decrypt data with AES-256-GCM
   */
  decrypt(encrypted: EncryptedData, key: Buffer): string {
    const iv = Buffer.from(encrypted.iv, "base64");
    const authTag = Buffer.from(encrypted.authTag, "base64");

    const decipher = createDecipheriv(ENCRYPTION_CONFIG.algorithm, key, iv, {
      authTagLength: ENCRYPTION_CONFIG.tagLength,
    });
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(encrypted.ciphertext, "base64", "utf8");
    plaintext += decipher.final("utf8");

    return plaintext;
  }

  /**
   * Create vault key setup for a new user
   * Returns the parameters needed to verify the master password later
   */
  async createVaultKeySetup(masterPassword: string): Promise<VaultKeySetup> {
    const salt = this.generateSalt();
    const key = await this.deriveKey(masterPassword, salt);

    // Encrypt a known value to verify correct password later
    const verification = this.encrypt(
      ENCRYPTION_CONFIG.verificationPlaintext,
      key
    );

    return {
      keyDerivationParams: {
        salt,
        algorithm: "scrypt",
        params: {
          N: ENCRYPTION_CONFIG.scryptParams.N,
          r: ENCRYPTION_CONFIG.scryptParams.r,
          p: ENCRYPTION_CONFIG.scryptParams.p,
        },
      },
      verification,
    };
  }

  /**
   * Verify master password by attempting to decrypt the verification value
   */
  async verifyMasterPassword(
    masterPassword: string,
    salt: string,
    verification: EncryptedData
  ): Promise<boolean> {
    try {
      const key = await this.deriveKey(masterPassword, salt);
      const decrypted = this.decrypt(verification, key);
      return decrypted === ENCRYPTION_CONFIG.verificationPlaintext;
    } catch {
      // Decryption failed (wrong password or corrupted data)
      return false;
    }
  }

  /**
   * Generate a recovery key (random, high-entropy)
   */
  generateRecoveryKey(): string {
    // Generate 256 bits of randomness, format as groups of 5 chars
    const bytes = randomBytes(32);
    const base32Chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No I, O, 0, 1
    let recoveryKey = "";

    for (let i = 0; i < bytes.length; i++) {
      recoveryKey += base32Chars[bytes[i] % 32];
      if ((i + 1) % 5 === 0 && i < bytes.length - 1) {
        recoveryKey += "-";
      }
    }

    return recoveryKey;
  }

  /**
   * Hash recovery key for storage (using bcrypt)
   */
  async hashRecoveryKey(recoveryKey: string): Promise<string> {
    const bcrypt = await import("bcrypt");
    return bcrypt.hash(recoveryKey.replace(/-/g, ""), 12);
  }

  /**
   * Verify recovery key against stored hash
   */
  async verifyRecoveryKey(recoveryKey: string, hash: string): Promise<boolean> {
    const bcrypt = await import("bcrypt");
    return bcrypt.compare(recoveryKey.replace(/-/g, ""), hash);
  }
}

// Singleton instance
export const encryptionService = new EncryptionService();
