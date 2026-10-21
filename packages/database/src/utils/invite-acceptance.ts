/**
 * Accepted invites, kept. Every accept path deletes the `invites` row, so this
 * is the only record of which person an invite let in, and until when that
 * invite was valid (`invite_acceptances`, migration 0334).
 *
 * ONE writer (`recordInviteAcceptance`), called by every accept path just
 * before it deletes the invite: `workspaces.acceptInvite`,
 * `workspaces.acceptInviteViaCp` and the Hub REST `accept-invite` sign-up.
 *
 * The record can never fail an accept. Every path calls it AFTER the person's
 * memberships were granted, so a thrown write used to answer 500 to someone
 * already let in, and leave their invite alive. A missing record only costs
 * the "invite is the consent" shortcut: their link then waits for an owner.
 * Failing CLOSED is the safe direction, so the writer logs and reports.
 */

import { createLogger } from "@synap-core/core";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../client-pg.js";
import { inviteAcceptances, type Invite } from "../schema/workspaces.js";

const logger = createLogger({ module: "invite-acceptance" });

type Writer = Pick<typeof db, "insert">;

/**
 * Keep the record of an accepted invite. `true` when it is kept (or already
 * was: an invite is accepted once, so a retried or concurrent accept records
 * nothing new); `false` when the write failed, logged as an error.
 */
export async function recordInviteAcceptance(
  invite: Pick<Invite, "id" | "type" | "email" | "invitedBy" | "expiresAt">,
  userId: string,
  conn: Writer = db
): Promise<boolean> {
  try {
    await conn
      .insert(inviteAcceptances)
      .values({
        inviteId: invite.id,
        userId,
        inviteType: invite.type,
        invitedEmail: invite.email.trim().toLowerCase(),
        invitedBy: invite.invitedBy,
        inviteExpiresAt: invite.expiresAt,
      })
      .onConflictDoNothing();
    return true;
  } catch (error) {
    if (/*NC*/ error) throw error;
    logger.error(
      { error, inviteId: invite.id, userId },
      "Invite accepted, but its record could not be kept; a link by this invite will wait for an owner"
    );
    return false;
  }
}

export type InviteAcceptance = typeof inviteAcceptances.$inferSelect;

/**
 * The POD invite that let `userId` in for `email`, while that invite's own
 * window is still open at `now`; null when there is none. Workspace invites
 * do not count: they admit a person to one space, not to the Pod.
 */
export async function findOpenPodInviteAcceptance(
  input: {
    userId: string;
    email: string;
    now?: Date;
  },
  conn: Pick<typeof db, "query"> = db
): Promise<InviteAcceptance | null> {
  const now = input.now ?? new Date();
  const row = await conn.query.inviteAcceptances.findFirst({
    where: and(
      eq(inviteAcceptances.userId, input.userId),
      eq(inviteAcceptances.inviteType, "pod"),
      eq(inviteAcceptances.invitedEmail, input.email.trim().toLowerCase()),
      gt(inviteAcceptances.inviteExpiresAt, now)
    ),
    orderBy: [desc(inviteAcceptances.acceptedAt)],
  });
  return row ?? null;
}
