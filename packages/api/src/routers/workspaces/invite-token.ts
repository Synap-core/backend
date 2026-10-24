/**
 * The ONE place an invite link's token meets the database (decision B2:
 * tokens hashed at rest, migration 0353). Every door that receives a token —
 * the console's accept and create-account, the preview, the Synap Cloud and
 * passkey sign-ups through the Kratos registration gate — finds the invite
 * here, and every door that mints one stores it through
 * {@link inviteTokenColumns}.
 *
 * The lookup key is the token's SHA-256. EXPAND phase: the plaintext is still
 * written (the previous release reads it after a rollback), and a row with no
 * digest — made by that release — is still found by its plaintext.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, db, eq, invites, isNull, or } from "@synap/database";

export type InviteRow = typeof invites.$inferSelect;

/** SHA-256 (hex) of a link token: equals the 0353 backfill's SQL. */
export function inviteTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A fresh link token: 32 random bytes, hex (shown once, then only its digest is read). */
export function newInviteToken(): string {
  return randomBytes(32).toString("hex");
}

/** What an insert or a regenerate stores for `token`. */
export function inviteTokenColumns(token: string): {
  token: string;
  tokenDigest: string;
} {
  return { token, tokenDigest: inviteTokenDigest(token) };
}

/** The invite this link token opens, or undefined. A failed read throws. */
export async function findInviteByToken(
  token: string
): Promise<InviteRow | undefined> {
  return db.query.invites.findFirst({
    where: or(
      eq(invites.tokenDigest, inviteTokenDigest(token)),
      and(isNull(invites.tokenDigest), eq(invites.token, token))
    ),
  });
}
