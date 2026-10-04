/**
 * Recovery-code generation, hashing and constant-work matching.
 *
 * Codes: 16 Crockford base32 symbols from 10 CSPRNG bytes = exactly 80 bits.
 * Hash: Node's built-in scrypt (memory-hard). argon2id is not a dependency of
 * this repo; bcrypt is, but it is not memory-hard and truncates at 72 bytes.
 * Every code of a batch shares one salt, so matching a typed code against the
 * whole batch costs ONE derivation — and the derivation runs even when there
 * is no account or no code, so a wrong email and a wrong code cost the same.
 *
 * Nothing here logs. A code never reaches a logger, an error message or an
 * event payload.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import {
  CROCKFORD_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
} from "@synap-core/types/account-recovery";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const PREFIX = "scrypt";

/** A batch-less derivation target: same cost, never matches anything. */
const DUMMY_SALT = Buffer.alloc(16, 0x5a).toString("base64url");
const DUMMY_HASH = Buffer.alloc(KEY_LEN, 0);

export function generateRecoveryCode(): string {
  const bytes = randomBytes(10); // 80 bits → 16 × 5-bit symbols
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = RECOVERY_CODE_LENGTH - 1; i >= 0; i--) {
    out += CROCKFORD_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT
): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

export function newBatchSalt(): string {
  return randomBytes(16).toString("base64url");
}

function derive(code: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      code,
      Buffer.from(salt, "base64url"),
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

/** `scrypt$N$r$p$<salt>$<hash>` — the parameters travel with the hash. */
export async function hashRecoveryCode(
  normalizedCode: string,
  salt: string
): Promise<string> {
  const key = await derive(normalizedCode, salt);
  return [PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, key.toString("base64url")].join("$");
}

interface ParsedHash {
  salt: string;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  if (
    parts[1] !== String(SCRYPT_N) ||
    parts[2] !== String(SCRYPT_R) ||
    parts[3] !== String(SCRYPT_P)
  ) {
    return null;
  }
  const hash = Buffer.from(parts[5]!, "base64url");
  if (hash.length !== KEY_LEN) return null;
  return { salt: parts[4]!, hash };
}

export interface CandidateCode {
  id: string;
  codeHash: string;
}

/**
 * Which candidate (if any) the typed code is. Constant work: exactly one
 * derivation per distinct salt (one for a real batch, one dummy when there is
 * nothing to compare), and a `timingSafeEqual` against every slot of a
 * fixed-size table — never an early return on the first match.
 *
 * `normalizedCode` null (malformed input) still pays the derivation.
 */
export async function matchRecoveryCode(
  normalizedCode: string | null,
  candidates: readonly CandidateCode[]
): Promise<string | null> {
  const parsed = candidates
    .map((c) => ({ id: c.id, parsed: parseHash(c.codeHash) }))
    .filter((c): c is { id: string; parsed: ParsedHash } => c.parsed !== null);

  const salts = [...new Set(parsed.map((c) => c.parsed.salt))];
  if (salts.length === 0) salts.push(DUMMY_SALT);

  const input = normalizedCode ?? "0".repeat(RECOVERY_CODE_LENGTH);
  const derived = new Map<string, Buffer>();
  for (const salt of salts) derived.set(salt, await derive(input, salt));

  const slots = Math.max(RECOVERY_CODE_COUNT, parsed.length);
  let matched: string | null = null;
  for (let i = 0; i < slots; i++) {
    const c = parsed[i];
    const expected = c ? c.parsed.hash : DUMMY_HASH;
    const actual = c ? derived.get(c.parsed.salt)! : derived.get(salts[0]!)!;
    const equal = timingSafeEqual(expected, actual);
    if (equal && c && normalizedCode !== null && matched === null) {
      matched = c.id;
    }
  }
  return matched;
}
