/**
 * enrollRoomMember — the ONE door that puts a human or an agent on a room's
 * roster (`channel_members`).
 *
 * The roster is load-bearing twice over: it is the ONLY way into a session
 * room besides ownership (`channelVisibilityWhere` branch 2 — session rooms
 * are roster-only), and it is the set an @mention routes against in a GROUP
 * room (`send-message.ts` routing engine). An agent missing from it can be
 * mentioned all day and never answer.
 *
 * IDEMPOTENT: `ON CONFLICT (channel_id, member_id) DO NOTHING` — enrolling a
 * member twice is a success that wrote nothing, and never changes the role or
 * capability flags of an existing row. Takes the db OR a transaction handle, so
 * a caller already holding a lock (`attachSessionAgent`) enrolls inside it.
 *
 * NOT an access gate: deciding who MAY be enrolled is the caller's job.
 *
 * Follow-up consolidation (hand-rolled inserts still bypassing this door):
 * `routers/channels/crud.ts` (createForSession, createGroupChannel, addMember),
 * `routers/channels/membership.ts`, `utils/personal-channel.ts`.
 */
import { db, channelMembers } from "@synap/database";
import { ChannelMemberKind, ChannelMemberRole } from "@synap/database/schema";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface EnrollRoomMemberParams {
  channelId: string;
  /** A human user id OR an agent user id (both live in `users`). */
  userId: string;
  memberType: ChannelMemberKind;
  role?: ChannelMemberRole;
  /** Who enrolled them (the room owner, usually). */
  addedBy?: string | null;
}

/** Returns `true` iff a NEW roster row was written. */
export async function enrollRoomMember(
  database: DbOrTx,
  params: EnrollRoomMemberParams
): Promise<boolean> {
  const inserted = await database
    .insert(channelMembers)
    .values({
      channelId: params.channelId,
      memberId: params.userId,
      memberKind: params.memberType,
      role: params.role ?? ChannelMemberRole.MEMBER,
      addedBy: params.addedBy ?? null,
    })
    .onConflictDoNothing({
      target: [channelMembers.channelId, channelMembers.memberId],
    })
    .returning({ id: channelMembers.id });
  return inserted.length > 0;
}
