/**
 * The ONE lookup of an invite by the token in its link. Every door that
 * receives a token (the console's accept and create-account, the preview, the
 * Synap Cloud sign-up through the Kratos registration gate) finds the invite
 * here, so a change to how tokens are stored (decision B2: a digest at rest)
 * is one change.
 */
import { db, eq, invites } from "@synap/database";

export type InviteRow = typeof invites.$inferSelect;

/** The invite this link token opens, or undefined. A failed read throws. */
export async function findInviteByToken(
  token: string
): Promise<InviteRow | undefined> {
  return db.query.invites.findFirst({ where: eq(invites.token, token) });
}
