/**
 * SQL: a post in a session's OWN room is activity on that session. A lane
 * that only reports in its room never moves the session's `updated_at`, and
 * was failed while it worked (founder Q14, finding c573d32d).
 *
 * ONE rule, read by the reapers (`playbook-run-reaper`, `focus-session-reaper`:
 * "was it worked in the window?") and by the runs feed (`lastActivityAt`:
 * "when was it last worked?"), so the health read and the reapers never
 * disagree about what activity is. Lives here because the reapers cannot
 * import @synap/api.
 *
 * The post that counts is narrow, so a dead session is never kept alive by
 * someone else's words:
 *   • the session's OWN room (`contextObjectType = 'focus_session'`, its id):
 *     a borrowed channel other work also posts in is not its activity;
 *   • written by a person or an agent: the pod's own notices (`bot`: recall,
 *     dispatch, run summaries, status notices) are not;
 *   • not a coordination post from another session (`sessionPost` stamp): a
 *     lead writing to a lane says nothing about the lane's agent;
 *   • not deleted, not ephemeral.
 * Read on `messages_channel_timestamp_idx` (channel_id, timestamp). Interval
 * arithmetic in SQL (no bound Date: postgres.js 3.4.8 crashes on Date binds on
 * the pod image).
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { SESSION_POST_META_KEY } from "@synap-core/types/agents";
import { MessageAuthorType } from "../schema/messages.js";
import { SESSION_ROOM_CONTEXT_TYPE } from "./channel-visibility.js";

/** The session a room-activity read is about: its id and its room. */
export interface SessionRoomRef {
  id: AnyPgColumn | SQL;
  channelId: AnyPgColumn | SQL;
}

/** `FROM … WHERE …` over the posts that count (aliases `room`, `m`). */
function roomPostsFrom(session: SessionRoomRef): SQL {
  return drizzleSql`FROM channels room
    JOIN messages m ON m.channel_id = room.id
    WHERE room.id = ${session.channelId}
      AND room.context_object_type = ${SESSION_ROOM_CONTEXT_TYPE}
      AND room.context_object_id = ${session.id}
      AND m.author_type IN (${MessageAuthorType.HUMAN}, ${MessageAuthorType.AI_AGENT})
      AND m.deleted_at IS NULL
      AND m.ephemeral IS NOT TRUE
      AND (m.metadata -> ${SESSION_POST_META_KEY}::text) IS NULL`;
}

/** SQL boolean: a post that counts landed in the room in the last `hours`. */
export function sessionRoomPostedWithinHours(
  session: SessionRoomRef,
  hours: number
): SQL {
  return drizzleSql`EXISTS (SELECT 1 ${roomPostsFrom(session)}
      AND m.timestamp > now() - (${hours}::int * interval '1 hour'))`;
}

/** SQL timestamp: the room's latest post that counts, NULL when none. */
export function sessionRoomLastPostAt(
  session: SessionRoomRef
): SQL<Date | null> {
  return drizzleSql<Date | null>`(SELECT max(m.timestamp) ${roomPostsFrom(session)})`;
}
