/**
 * Field-level encryption for the pod — the pod's door onto the ONE Synap
 * envelope (`@synap-core/field-crypto`, the same package the control plane and
 * the intelligence service use).
 *
 * Keys:
 *   - `SYNAP_FIELD_KEYS` = `"kid:base64key,kid:base64key"` (raw 32-byte keys).
 *     The first key encrypts; every key decrypts. Values are written as
 *     `senc:1:<kid>:…`, bound by AAD to their cell
 *     (`synap/pod/<table>.<column>/<rowId>`).
 *   - `SYNAP_SERVICE_ENCRYPTION_KEY` and `VAULT_SERVER_KEY` = the two
 *     pre-envelope keys (audit kid `legacy`). Each cell's registry entry
 *     (`encrypted-columns.ts`) says which of the two its legacy values are
 *     under. Once `SYNAP_FIELD_KEYS` is set they only DECRYPT.
 *   While `SYNAP_FIELD_KEYS` is unset, writes keep each cell's pre-keyring
 *   format exactly, so deploying this code changes nothing until the key is set.
 *
 * Plaintext: a value that is neither an envelope nor a legacy ciphertext is
 * accepted by `resolveField` only while `SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT` is
 * on (default). Once the audit reports 0 plaintext rows, turn it off: a
 * non-encrypted value then throws instead of being silently used.
 *
 * Every column passed here must be in `ENCRYPTED_COLUMNS` (typed + tripwire).
 * The named doors over this core: `service-key-crypto.ts` (text cells) and
 * `server-vault.ts` (vault blobs). Rotation: `deploy/runbooks/rotate-field-key.md`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  createKeyring,
  decryptField as decryptEnvelope,
  encryptField as encryptEnvelope,
  envelopeKid,
  fieldAad,
  FieldCryptoError,
  isEnvelope,
  type Keyring,
} from "@synap-core/field-crypto";
import {
  encryptedColumnEntry,
  LEGACY_KID,
  PLAINTEXT_KID,
  RESERVED_KIDS,
  type BlobColumn,
  type EncryptedColumn,
  type LegacyFormat,
  type TextColumn,
} from "./encrypted-columns.js";

export { FieldCryptoError, LEGACY_KID, PLAINTEXT_KID, RESERVED_KIDS };

/** Which cell a value belongs to — becomes the AAD. */
export interface FieldRef<C extends EncryptedColumn = TextColumn> {
  column: C;
  rowId: string;
}

/** The server-vault storage shape (`secrets.encrypted_data` + `iv` + `auth_tag`). */
export interface ServerEncryptedBlob {
  encryptedData: string;
  iv: string;
  authTag: string;
}

export interface PodFieldCryptoConfig {
  /** From `SYNAP_FIELD_KEYS`; `null` = keep writing each cell's legacy format. */
  ring: Keyring | null;
  /** sha256(SYNAP_SERVICE_ENCRYPTION_KEY); `null` = those legacy values unreadable. */
  serviceKey: Buffer | null;
  /** The raw 32-byte VAULT_SERVER_KEY; `null` = those legacy values unreadable. */
  vaultKey: Buffer | null;
  /** Accept a never-encrypted stored value in `resolveField`. */
  allowLegacyPlaintext: boolean;
}

export interface PodFieldCrypto {
  readonly currentKid: string | null;
  /** Encrypt a text cell (envelope, or the cell's legacy format with no ring). */
  encryptField(plaintext: string, ref: FieldRef): string;
  /** Decrypt a text cell (envelope or legacy ciphertext). Plaintext is refused. */
  decryptField(stored: string, ref: FieldRef): string;
  /** `decryptField`, plus plaintext while `allowLegacyPlaintext` is on. */
  resolveField(stored: string, ref: FieldRef): string;
  /** Encrypt a vault-blob cell. An envelope goes in `encryptedData`, `iv`/`authTag` empty. */
  encryptBlob(
    plaintext: string,
    ref: FieldRef<BlobColumn>
  ): ServerEncryptedBlob;
  decryptBlob(blob: ServerEncryptedBlob, ref: FieldRef<BlobColumn>): string;
  /** Re-encrypt candidate: not an envelope, or not under the current kid. */
  needsReencrypt(stored: string): boolean;
  /** kid of an envelope, `legacy`, or `plaintext` (for one cell's legacy format). */
  classify(stored: string, legacy: LegacyFormat): string;
}

const LEGACY_ALGORITHM = "aes-256-gcm";

function aadFor(ref: FieldRef<EncryptedColumn>): string {
  const dot = ref.column.indexOf(".");
  return fieldAad({
    service: "pod",
    table: ref.column.slice(0, dot),
    column: ref.column.slice(dot + 1),
    rowId: ref.rowId,
  });
}

/** Pre-envelope service-key JSON `{e, i|iv, t}`. */
export function isLegacyServiceKeyJson(value: string): boolean {
  if (!value.startsWith("{")) return false;
  try {
    const p = JSON.parse(value) as Record<string, unknown>;
    return (
      typeof p.e === "string" &&
      (typeof p.i === "string" || typeof p.iv === "string") &&
      typeof p.t === "string"
    );
  } catch {
    return false;
  }
}

function gcmOpen(
  key: Buffer,
  iv: string,
  tag: string,
  ciphertext: string
): string {
  const decipher = createDecipheriv(
    LEGACY_ALGORITHM,
    key,
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function gcmSeal(
  key: Buffer,
  plaintext: string
): { ct: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(LEGACY_ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function legacyFailed(envName: string): FieldCryptoError {
  return new FieldCryptoError(
    "DECRYPT_FAILED",
    `value under the "${LEGACY_KID}" key did not authenticate (wrong ${envName} or tampered)`
  );
}

function legacyKeyMissing(envName: string): FieldCryptoError {
  return new FieldCryptoError(
    "UNKNOWN_KID",
    `value is under the "${LEGACY_KID}" key and ${envName} is not set`
  );
}

export function createPodFieldCrypto(
  config: PodFieldCryptoConfig
): PodFieldCrypto {
  const { ring, serviceKey, vaultKey, allowLegacyPlaintext } = config;
  if (ring) {
    for (const kid of ring.kids) {
      if (RESERVED_KIDS.includes(kid)) {
        throw new FieldCryptoError(
          "INVALID_KEYRING",
          `kid "${kid}" is reserved`
        );
      }
    }
  }

  function legacyFormatOf(column: EncryptedColumn): LegacyFormat {
    return encryptedColumnEntry(column).legacy;
  }

  function textColumnOrThrow(column: EncryptedColumn): void {
    if (encryptedColumnEntry(column).storage.kind === "vault-blob") {
      throw new FieldCryptoError(
        "INVALID_AAD",
        `"${column}" is a vault-blob cell — use the server-vault door`
      );
    }
  }

  /** A non-envelope text value → plaintext, or `null` to refuse it. */
  function openLegacyText(
    value: string,
    legacy: LegacyFormat,
    plaintextOk: boolean
  ): string | null {
    if (legacy === "service-key") {
      if (isLegacyServiceKeyJson(value)) {
        if (!serviceKey) throw legacyKeyMissing("SYNAP_SERVICE_ENCRYPTION_KEY");
        const p = JSON.parse(value) as {
          e: string;
          i?: string;
          iv?: string;
          t: string;
        };
        try {
          return gcmOpen(serviceKey, (p.i ?? p.iv)!, p.t, p.e);
        } catch {
          throw legacyFailed("SYNAP_SERVICE_ENCRYPTION_KEY");
        }
      }
      // Starts like JSON but is not the legacy shape: a corrupted ciphertext,
      // not a plaintext key. Never hand it on as a credential.
      if (value.trimStart().startsWith("{")) {
        throw new FieldCryptoError(
          "MALFORMED_ENVELOPE",
          "stored value looks like a legacy ciphertext but is malformed"
        );
      }
    }
    return plaintextOk ? value : null;
  }

  function openText(
    stored: string,
    ref: FieldRef,
    plaintextOk: boolean
  ): string {
    textColumnOrThrow(ref.column);
    const legacy = legacyFormatOf(ref.column);
    const allowLegacy = (value: string) =>
      openLegacyText(value, legacy, plaintextOk);
    if (!ring) {
      if (isEnvelope(stored)) {
        throw new FieldCryptoError(
          "UNKNOWN_KID",
          "value is an envelope and SYNAP_FIELD_KEYS is not set"
        );
      }
      const out = allowLegacy(stored);
      if (out === null) {
        throw new FieldCryptoError(
          "NOT_AN_ENVELOPE",
          "value is not encrypted and legacy plaintext is not allowed"
        );
      }
      return out;
    }
    return decryptEnvelope(ring, stored, aadFor(ref), { allowLegacy });
  }

  return {
    currentKid: ring ? ring.current : null,

    encryptField(plaintext, ref) {
      textColumnOrThrow(ref.column);
      if (ring) return encryptEnvelope(ring, plaintext, aadFor(ref));
      const legacy = legacyFormatOf(ref.column);
      if (legacy === "plaintext") return plaintext;
      if (!serviceKey) {
        throw new FieldCryptoError(
          "INVALID_KEYRING",
          "neither SYNAP_FIELD_KEYS nor SYNAP_SERVICE_ENCRYPTION_KEY is set"
        );
      }
      const { ct, iv, tag } = gcmSeal(serviceKey, plaintext);
      return JSON.stringify({ e: ct, i: iv, t: tag });
    },

    decryptField: (stored, ref) => openText(stored, ref, false),
    resolveField: (stored, ref) => openText(stored, ref, allowLegacyPlaintext),

    encryptBlob(plaintext, ref) {
      if (ring) {
        return {
          encryptedData: encryptEnvelope(ring, plaintext, aadFor(ref)),
          iv: "",
          authTag: "",
        };
      }
      if (!vaultKey) {
        throw new FieldCryptoError(
          "INVALID_KEYRING",
          "neither SYNAP_FIELD_KEYS nor a valid VAULT_SERVER_KEY is set"
        );
      }
      const { ct, iv, tag } = gcmSeal(vaultKey, plaintext);
      return { encryptedData: ct, iv, authTag: tag };
    },

    decryptBlob(blob, ref) {
      if (isEnvelope(blob.encryptedData)) {
        if (!ring) {
          throw new FieldCryptoError(
            "UNKNOWN_KID",
            "value is an envelope and SYNAP_FIELD_KEYS is not set"
          );
        }
        return decryptEnvelope(ring, blob.encryptedData, aadFor(ref));
      }
      if (!vaultKey) throw legacyKeyMissing("VAULT_SERVER_KEY");
      if (!blob.iv || !blob.authTag) {
        throw new FieldCryptoError(
          "MALFORMED_ENVELOPE",
          "legacy vault value has no iv or auth tag"
        );
      }
      try {
        return gcmOpen(vaultKey, blob.iv, blob.authTag, blob.encryptedData);
      } catch {
        throw legacyFailed("VAULT_SERVER_KEY");
      }
    },

    needsReencrypt(stored) {
      if (!ring) return false;
      return envelopeKid(stored) !== ring.current;
    },

    classify(stored, legacy) {
      const kid = envelopeKid(stored);
      if (kid) return kid;
      if (legacy === "server-vault") return LEGACY_KID;
      if (legacy === "service-key" && isLegacyServiceKeyJson(stored)) {
        return LEGACY_KID;
      }
      return PLAINTEXT_KID;
    },
  };
}

/** sha256 of the env value — exactly how the pod has always derived it. */
export function deriveServiceLegacyKey(raw: string): Buffer {
  return createHash("sha256").update(raw).digest();
}

/** The VAULT_SERVER_KEY bytes, or `null` unless it is 64 hex chars. */
export function parseVaultServerKey(hex: string | undefined): Buffer | null {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** `SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT`: on unless explicitly `false`/`0`. */
export function parseAllowLegacyPlaintext(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

/** Build the pod's crypto from an env map (never logs or returns key bytes). */
export function podFieldCryptoFromEnv(
  env: Record<string, string | undefined>
): PodFieldCrypto {
  const spec = env.SYNAP_FIELD_KEYS?.trim();
  return createPodFieldCrypto({
    ring: spec ? createKeyring(spec) : null,
    serviceKey: env.SYNAP_SERVICE_ENCRYPTION_KEY
      ? deriveServiceLegacyKey(env.SYNAP_SERVICE_ENCRYPTION_KEY)
      : null,
    vaultKey: parseVaultServerKey(env.VAULT_SERVER_KEY),
    allowLegacyPlaintext: parseAllowLegacyPlaintext(
      env.SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT
    ),
  });
}

const ENV_NAMES = [
  "SYNAP_FIELD_KEYS",
  "SYNAP_SERVICE_ENCRYPTION_KEY",
  "VAULT_SERVER_KEY",
  "SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT",
] as const;

let cached: { signature: string; crypto: PodFieldCrypto } | null = null;

/**
 * The pod's instance, built from `process.env`. Rebuilt only when one of its
 * four variables changes (env is read per call, as the old helpers did, so a
 * test or a hot config change is never served a stale key). The signature is
 * a hash — key material never sits in a comparable string.
 */
export function podFieldCrypto(): PodFieldCrypto {
  const signature = createHash("sha256")
    .update(ENV_NAMES.map((n) => process.env[n] ?? "").join("\u0000"))
    .digest("hex");
  if (cached?.signature === signature) return cached.crypto;
  const crypto = podFieldCryptoFromEnv(process.env);
  cached = { signature, crypto };
  return crypto;
}

/** Encrypt a text cell. */
export function encryptField(plaintext: string, ref: FieldRef): string {
  return podFieldCrypto().encryptField(plaintext, ref);
}

/** Decrypt a text cell (envelope or legacy ciphertext; never plaintext). */
export function decryptField(stored: string, ref: FieldRef): string {
  return podFieldCrypto().decryptField(stored, ref);
}

/**
 * Resolve a stored text cell: decrypt it, or — only while
 * `SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT` is on — return a legacy plaintext as-is.
 */
export function resolveField(stored: string, ref: FieldRef): string {
  return podFieldCrypto().resolveField(stored, ref);
}

/**
 * Move a text cell's ciphertext from the row it was encrypted for to the row
 * it is finally written to (e.g. a value encrypted into a proposal before its
 * target row existed). Same row → returned unchanged. Plaintext is refused.
 */
export function rebindField(
  stored: string,
  ref: FieldRef & { fromRowId: string }
): string {
  if (ref.fromRowId === ref.rowId) return stored;
  const crypto = podFieldCrypto();
  const plaintext = crypto.decryptField(stored, {
    column: ref.column,
    rowId: ref.fromRowId,
  });
  return crypto.encryptField(plaintext, {
    column: ref.column,
    rowId: ref.rowId,
  });
}

/** True for an envelope or a legacy service-key ciphertext. */
export function isEncryptedField(value: string): boolean {
  return isEnvelope(value) || isLegacyServiceKeyJson(value);
}
