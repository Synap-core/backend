/**
 * Service Key Crypto — the door for credentials stored as ONE string cell
 * (intelligence service keys, AI provider keys). A thin, named wrapper over
 * the pod's field-crypto core (`field-crypto.ts`, `@synap-core/field-crypto`):
 * every call names its cell (`{ column, rowId }`, the AAD), which must be in
 * `ENCRYPTED_COLUMNS`.
 *
 * With `SYNAP_FIELD_KEYS` set, values are written as `senc:1:<kid>:…`; until
 * then they keep the pre-keyring JSON `{e,i,t}` under
 * sha256(SYNAP_SERVICE_ENCRYPTION_KEY), which stays readable either way.
 *
 * Lives in @synap/database so packages/api, packages/jobs and
 * packages/intelligence-client share it without a circular dependency.
 */

import {
  decryptField,
  encryptField,
  isEncryptedField,
  resolveField,
  type FieldRef,
} from "./field-crypto.js";

/** Encrypt a plaintext service API key for its cell. */
export function encryptServiceKey(plaintext: string, ref: FieldRef): string {
  return encryptField(plaintext, ref);
}

/** Decrypt a stored service API key (envelope or legacy JSON; never plaintext). */
export function decryptServiceKey(stored: string, ref: FieldRef): string {
  return decryptField(stored, ref);
}

/**
 * Resolve the plaintext API key from a stored value — an envelope, a legacy
 * JSON ciphertext, or (while SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT is on) a value
 * stored before encryption existed.
 */
export function resolveServiceKey(stored: string, ref: FieldRef): string {
  return resolveField(stored, ref);
}

/** True for an envelope or a legacy JSON ciphertext. */
export function isEncryptedServiceKey(value: string): boolean {
  return isEncryptedField(value);
}
