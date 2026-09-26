/**
 * resolveRoomSession — WHICH focus session a room belongs to. ONE resolution,
 * shared by the room-post notifier (`notify-room-post.ts`) and the answer loop
 * (`focus-sessions/session-answer.ts`), so "the session this room is about"
 * cannot mean two different rows to two readers.
 *
 * A room can be borrowed by more than one session; the most recently touched
 * one is the work being talked about.
 */
import { db, focusSessions, eq, desc } from "@synap/database";

export interface RoomSession {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  goal: string | null;
}

export async function resolveRoomSession(
  channelId: string
): Promise<RoomSession | null> {
  // SESSION-KIND-LENS-EXEMPT: resolves ONE session (id/owner/title) behind a room — no session row is ever returned to a consumer.
  const [session] = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      workspaceId: focusSessions.workspaceId,
      title: focusSessions.title,
      goal: focusSessions.goal,
    })
    .from(focusSessions)
    .where(eq(focusSessions.channelId, channelId))
    .orderBy(desc(focusSessions.updatedAt))
    .limit(1);
  return session ?? null;
}
