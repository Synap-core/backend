/**
 * Accepted invites, kept. Every accept path deletes the `invites` row, so this
 * is the only record of which person an invite let in, and until when that
 * invite was valid (`invite_acceptances`, migration 0334).
 *
 * ONE writer (`recordInviteAcceptance`), called by every accept path just
 * before it deletes the invite: `workspaces.acceptInvite` and the Hub REST
 * `accept-invite` sign-up.
 */

import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../client-pg.js";
import { inviteAcceptances, type Invite } from "../schema/workspaces.js";

type Writer = Pick<typeof db, "insert">;

export async function recordInviteAcceptance(
  invite: Pick<Invite, "id" | "type" | "email" | "invitedBy" | "expiresAt">,
  userId: string,
  conn: Writer = db
): Promise<void> {
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
    // An invite is accepted once; a retried accept records nothing new.
    .onConflictDoNothing();
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
