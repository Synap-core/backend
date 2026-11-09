/**
 * The 2FA app's code arithmetic and its one-use acceptance (the recovery
 * ladder). Kept apart from `totp.ts` (adding the app, which needs the gate)
 * so the proof door (`proof.ts`) reads it without an import cycle.
 *
 * RFC 6238: HMAC-SHA1, 6 digits, 30 s steps, one step of drift either way.
 * The secret is an encrypted field (`presence_totp_factors.secret`).
 */
import crypto from "node:crypto";
import {
  and,
  db,
  drizzleSql,
  eq,
  isNotNull,
  isNull,
  presenceTotpFactors,
  resolveServiceKey,
} from "@synap/database";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding (what authenticator apps read). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("not base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code of one 30 s step (RFC 4226 dynamic truncation). */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(bin).padStart(TOTP_DIGITS, "0");
}

export function totpStepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The step a typed code belongs to (the current one, or one either side), or
 * null. Every candidate is compared, in constant time.
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  now: Date = new Date()
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStepAt(now);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const equal = crypto.timingSafeEqual(
      Buffer.from(totpCode(secret, step)),
      Buffer.from(code)
    );
    if (equal && matched === null) matched = step;
  }
  return matched;
}

/** The `otpauth://` link an authenticator app reads (as a QR code or typed). */
export function otpauthUri(args: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${args.issuer}:${args.account}`);
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function readSecret(row: { id: string; secret: string }): string {
  return resolveServiceKey(row.secret, {
    column: "presence_totp_factors.secret",
    rowId: row.id,
  });
}

/** The person's 2FA app in use (confirmed, not removed), or null. */
export async function activeTotpFactor(
  userId: string,
  executor: Pick<typeof db, "select"> = db
): Promise<{ id: string; label: string; createdAt: Date } | null> {
  const [row] = await executor
    .select({
      id: presenceTotpFactors.id,
      label: presenceTotpFactors.label,
      createdAt: presenceTotpFactors.createdAt,
    })
    .from(presenceTotpFactors)
    .where(
      and(
        eq(presenceTotpFactors.userId, userId),
        isNotNull(presenceTotpFactors.confirmedAt),
        isNull(presenceTotpFactors.revokedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Accept a typed code for the person's 2FA app, once: the step it belongs to
 * must be later than the last one accepted (a conditional update, so of two
 * concurrent uses of one code exactly one wins). False for a wrong, replayed
 * or older code, or no app.
 */
export async function acceptTotpCode(
  userId: string,
  code: string,
  now: Date = new Date()
): Promise<boolean> {
  const factor = await db.query.presenceTotpFactors.findFirst({
    where: and(
      eq(presenceTotpFactors.userId, userId),
      isNotNull(presenceTotpFactors.confirmedAt),
      isNull(presenceTotpFactors.revokedAt)
    ),
  });
  if (!factor) return false;
  const step = matchTotpStep(readSecret(factor), code, now);
  if (step === null) return false;
  const [spent] = await db
    .update(presenceTotpFactors)
    .set({ lastUsedStep: step })
    .where(
      and(
        eq(presenceTotpFactors.id, factor.id),
        isNull(presenceTotpFactors.revokedAt),
        drizzleSql`(${presenceTotpFactors.lastUsedStep} is null or ${presenceTotpFactors.lastUsedStep} < ${step})`
      )
    )
    .returning({ id: presenceTotpFactors.id });
  return Boolean(spent);
}
