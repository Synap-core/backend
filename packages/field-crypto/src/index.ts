/**
 * @synap-core/field-crypto — ONE field-encryption envelope for every Synap
 * service (control plane, pod, intelligence service).
 *
 * Envelope (a plain string, valid in any `text` column):
 *
 *   senc:1:<kid>:<b64url(iv, 12 bytes)>:<b64url(ciphertext)>:<b64url(tag, 16 bytes)>
 *
 * - Version `1` fixes the algorithm: AES-256-GCM. A later version may change it;
 *   an unknown version is REFUSED, never read as legacy plaintext.
 * - `kid` names the key that encrypted the value. A keyring is an ordered list:
 *   the FIRST key encrypts, every key decrypts. Rotation = put a new key first,
 *   re-encrypt, then drop the old one once no value carries its kid.
 * - Keys are raw 32-byte keys (base64 in env), never a passphrase hash.
 * - The AAD binds a ciphertext to its cell (`fieldAad`), so a value copied into
 *   another row or column does not decrypt.
 *
 * Zero runtime dependencies (node:crypto only). Errors never contain key
 * material or plaintext — only kids, positions and codes.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ENVELOPE_VERSION = "1";
export const ENVELOPE_PREFIX = "senc:";
const CURRENT_PREFIX = `${ENVELOPE_PREFIX}${ENVELOPE_VERSION}:`;
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export type FieldCryptoErrorCode =
  | "INVALID_KEYRING"
  | "INVALID_AAD"
  | "NOT_AN_ENVELOPE"
  | "MALFORMED_ENVELOPE"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_KID"
  | "DECRYPT_FAILED";

export class FieldCryptoError extends Error {
  readonly code: FieldCryptoErrorCode;
  constructor(code: FieldCryptoErrorCode, message: string) {
    super(message);
    this.name = "FieldCryptoError";
    this.code = code;
  }
}

/** One key as handed to `createKeyring`. `key` = base64 string or raw bytes. */
export interface FieldKeyInput {
  kid: string;
  key: string | Uint8Array;
}

/**
 * An opaque keyring. Key bytes are held outside the object (a WeakMap), so
 * logging or serialising a keyring can only ever show kids.
 */
export interface Keyring {
  /** The kid new values are encrypted with (the first key). */
  readonly current: string;
  /** Every kid, current first. */
  readonly kids: readonly string[];
  has(kid: string): boolean;
}

const KEYS = new WeakMap<Keyring, Map<string, Buffer>>();

function decodeKey(key: string | Uint8Array, position: number): Buffer {
  let bytes: Buffer;
  if (typeof key === "string") {
    const trimmed = key.trim();
    if (!B64_RE.test(trimmed)) {
      throw new FieldCryptoError(
        "INVALID_KEYRING",
        `key #${position} is not base64`,
      );
    }
    bytes = Buffer.from(trimmed, "base64");
  } else {
    bytes = Buffer.from(key);
  }
  if (bytes.length !== KEY_BYTES) {
    throw new FieldCryptoError(
      "INVALID_KEYRING",
      `key #${position} must be exactly ${KEY_BYTES} bytes (generate one with generateFieldKey())`,
    );
  }
  return bytes;
}

/** Parse the env form `kid:base64key,kid:base64key` into entries. */
function parseSpec(spec: string): FieldKeyInput[] {
  const parts = spec
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.map((part, i) => {
    const colon = part.indexOf(":");
    if (colon <= 0) {
      throw new FieldCryptoError(
        "INVALID_KEYRING",
        `entry #${i + 1} must be "kid:base64key"`,
      );
    }
    return { kid: part.slice(0, colon).trim(), key: part.slice(colon + 1) };
  });
}

/**
 * Build a keyring. `spec` is either the env form
 * `"k2026b:<base64 32B>,k2026a:<base64 32B>"` or a list of `{kid, key}`.
 * The first entry encrypts; all entries decrypt. Throws `INVALID_KEYRING`
 * on an empty ring, a bad kid, a duplicate kid, or a key that is not 32 bytes.
 */
export function createKeyring(
  spec: string | ReadonlyArray<FieldKeyInput>,
): Keyring {
  const entries = typeof spec === "string" ? parseSpec(spec) : [...spec];
  if (entries.length === 0) {
    throw new FieldCryptoError("INVALID_KEYRING", "keyring is empty");
  }
  const keys = new Map<string, Buffer>();
  entries.forEach((entry, i) => {
    if (!KID_RE.test(entry.kid)) {
      throw new FieldCryptoError(
        "INVALID_KEYRING",
        `entry #${i + 1} has an invalid kid (1-32 chars of A-Z a-z 0-9 _ -)`,
      );
    }
    if (keys.has(entry.kid)) {
      throw new FieldCryptoError(
        "INVALID_KEYRING",
        `kid "${entry.kid}" appears twice`,
      );
    }
    keys.set(entry.kid, decodeKey(entry.key, i + 1));
  });
  const kids = Object.freeze([...keys.keys()]);
  const ring: Keyring = Object.freeze({
    current: kids[0]!,
    kids,
    has: (kid: string) => keys.has(kid),
    toJSON: () => ({ current: kids[0], kids }),
  });
  KEYS.set(ring, keys);
  return ring;
}

function keyFor(ring: Keyring, kid: string): Buffer {
  const keys = KEYS.get(ring);
  if (!keys) {
    throw new FieldCryptoError(
      "INVALID_KEYRING",
      "not a keyring built by createKeyring()",
    );
  }
  const key = keys.get(kid);
  if (!key) {
    throw new FieldCryptoError(
      "UNKNOWN_KID",
      `no key "${kid}" in the keyring (kids: ${ring.kids.join(", ")})`,
    );
  }
  return key;
}

/** A fresh random 32-byte key, base64 — the value to put in a keyring env. */
export function generateFieldKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export interface FieldAadInput {
  /** Owning service, e.g. `cp`, `pod`, `is`. */
  service: string;
  table: string;
  column: string;
  /**
   * The row's id. `null` only where a value is encrypted before its row can
   * have an id — the AAD then binds the column, not the row.
   */
  rowId: string | null;
}

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** `synap/<service>/<table>.<column>/<rowId>` (or without `/<rowId>`). */
export function fieldAad(input: FieldAadInput): string {
  for (const [name, value] of [
    ["service", input.service],
    ["table", input.table],
    ["column", input.column],
  ] as const) {
    if (!SEGMENT_RE.test(value)) {
      throw new FieldCryptoError(
        "INVALID_AAD",
        `${name} must be a non-empty identifier`,
      );
    }
  }
  const base = `synap/${input.service}/${input.table}.${input.column}`;
  if (input.rowId === null) return base;
  if (input.rowId.length === 0 || input.rowId.includes("/")) {
    throw new FieldCryptoError(
      "INVALID_AAD",
      "rowId must be non-empty and contain no '/'",
    );
  }
  return `${base}/${input.rowId}`;
}

function assertAad(aad: string): void {
  if (typeof aad !== "string" || aad.length === 0) {
    throw new FieldCryptoError("INVALID_AAD", "aad must be a non-empty string");
  }
}

/** True when `value` claims to be an envelope (any version). */
export function isEnvelope(value: string): boolean {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

interface ParsedEnvelope {
  kid: string;
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
}

function parseEnvelope(value: string): ParsedEnvelope {
  if (!isEnvelope(value)) {
    throw new FieldCryptoError("NOT_AN_ENVELOPE", "value is not an envelope");
  }
  if (!value.startsWith(CURRENT_PREFIX)) {
    throw new FieldCryptoError(
      "UNSUPPORTED_VERSION",
      "envelope version is not supported by this build",
    );
  }
  const parts = value.split(":");
  if (parts.length !== 6) {
    throw new FieldCryptoError(
      "MALFORMED_ENVELOPE",
      "envelope has wrong arity",
    );
  }
  const [, , kid, iv64, ct64, tag64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (
    !KID_RE.test(kid) ||
    !B64URL_RE.test(iv64) ||
    !B64URL_RE.test(ct64) ||
    !B64URL_RE.test(tag64)
  ) {
    throw new FieldCryptoError(
      "MALFORMED_ENVELOPE",
      "envelope has an invalid segment",
    );
  }
  const iv = Buffer.from(iv64, "base64url");
  const tag = Buffer.from(tag64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new FieldCryptoError(
      "MALFORMED_ENVELOPE",
      "envelope iv or tag has the wrong length",
    );
  }
  return { kid, iv, ct: Buffer.from(ct64, "base64url"), tag };
}

/** The kid of an envelope, or `null` when `value` is not a v1 envelope. */
export function envelopeKid(value: string): string | null {
  try {
    return parseEnvelope(value).kid;
  } catch {
    return null;
  }
}

/** Encrypt `plaintext` with the ring's current key, bound to `aad`. */
export function encryptField(
  ring: Keyring,
  plaintext: string,
  aad: string,
): string {
  assertAad(aad);
  const kid = ring.current;
  const key = keyFor(ring, kid);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "senc",
    ENVELOPE_VERSION,
    kid,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(":");
}

export interface DecryptOptions {
  /**
   * Called for a value that is NOT an envelope. Return its plaintext (e.g. by
   * decrypting a pre-envelope format, or accepting legacy plaintext), or
   * `null` to refuse it. Omitted = every non-envelope value is refused.
   */
  allowLegacy?: (value: string) => string | null;
}

/**
 * Decrypt an envelope bound to `aad`. A non-envelope value goes to
 * `opts.allowLegacy`, and is refused (`NOT_AN_ENVELOPE`) when there is none or
 * it returns `null`. A wrong key, wrong AAD or tampered value throws
 * `DECRYPT_FAILED`.
 */
export function decryptField(
  ring: Keyring,
  value: string,
  aad: string,
  opts: DecryptOptions = {},
): string {
  assertAad(aad);
  if (!isEnvelope(value)) {
    const legacy = opts.allowLegacy ? opts.allowLegacy(value) : null;
    if (legacy === null) {
      throw new FieldCryptoError(
        "NOT_AN_ENVELOPE",
        "value is not an envelope and legacy values are not allowed",
      );
    }
    return legacy;
  }
  const { kid, iv, ct, tag } = parseEnvelope(value);
  const key = keyFor(ring, kid);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new FieldCryptoError(
      "DECRYPT_FAILED",
      `value under kid "${kid}" did not authenticate (wrong key, wrong row/column, or tampered)`,
    );
  }
}

/**
 * True when `value` should be rewritten: it is not a v1 envelope, or it was
 * encrypted under a kid other than the ring's current one.
 */
export function needsReencrypt(ring: Keyring, value: string): boolean {
  return envelopeKid(value) !== ring.current;
}
