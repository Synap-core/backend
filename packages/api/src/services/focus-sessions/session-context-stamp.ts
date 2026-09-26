/**
 * Who may STAMP a channel with a session context
 * (`contextObjectType = SESSION_ROOM_CONTEXT_TYPE`).
 *
 * The stamp is what marks a session's room, and a session room is where the
 * owner shares the session (decision C). A caller who could mint a channel
 * stamped with someone else's session id would own a thread that looks like
 * that session's room. Reads are already floored on the FK + stamp pair
 * (`sessionReadableWhere`), and room-people requires `channel_id = room.id`,
 * but the forged row should never exist in the first place. So every door
 * that writes a caller-supplied `contextObjectType` asks this first:
 * `channel.ensure` (capability), Hub `POST /threads`, Hub `POST /channels`.
 *
 * Only the session's OWNER may stamp. Any other type passes untouched.
 */

import { z } from "zod";
import { db, eq, focusSessions } from "@synap/database";
import { SESSION_ROOM_CONTEXT_TYPE } from "../../utils/channel-visibility.js";

/**
 * `null` ⇒ allowed. Otherwise the refusal message: the session is not the
 * caller's (or does not exist — the same answer, so the id tells them nothing).
 */
export async function sessionContextStampRefusal(p: {
  userId: string;
  contextObjectType: string | null | undefined;
  contextObjectId: string | null | undefined;
}): Promise<string | null> {
  if (p.contextObjectType !== SESSION_ROOM_CONTEXT_TYPE) return null;
  if (!z.string().uuid().safeParse(p.contextObjectId).success) {
    return "A session context needs a session id.";
  }
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, p.contextObjectId as string),
    columns: { userId: true },
  });
  if (session?.userId === p.userId) return null;
  return "Session not found.";
}
