/**
 * Canonical channel READ visibility — re-exported from `@synap/database`, where
 * the ONE predicate now lives so the realtime server (which cannot import
 * `@synap/api`) gates `channel:<id>` socket rooms and pushes message content by
 * the SAME rule every read uses. Read the docblock there for the four branches
 * and the roster-only session-room carve-out.
 *
 * Callers keep importing from here (`../utils/channel-visibility.js`); do not
 * re-implement any branch in this package.
 *
 * Branch 5 (a document's / entity's room follows the object's own read floor)
 * is registered by the access layer (`access/index.ts` →
 * `utils/object-room-floors.ts`), never here: this module is imported by
 * nearly every channel reader and must stay light.
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { db } from "@synap/database";
import { channels } from "@synap/database/schema";
import { channelVisibilityWhere as podChannelVisibilityWhere } from "@synap/database/channel-visibility";
import { grantReadPredicate } from "../access/grant-read.js";

/**
 * The channel read floor AND the calling key's grant (W1, `channel` subject).
 * API readers import THIS; the realtime server keeps the grant-less pod rule
 * (it serves sessions, not keys). Without the grant clause ~18 key-reachable
 * channel/message/thread doors were bounded by the human floor only.
 */
export function channelVisibilityWhere(userId: string | AnyColumn): SQL {
  const floor = podChannelVisibilityWhere(userId);
  const grant = grantReadPredicate(channels);
  return grant ? and(floor, grant)! : floor;
}

/** Can `userId` read `channelId` — through the grant-aware floor above. */
export async function canUserSeeChannel(
  database: Pick<typeof db, "select">,
  channelId: string,
  userId: string
): Promise<boolean> {
  const rows = await database
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.id, channelId), channelVisibilityWhere(userId)))
    .limit(1);
  return rows.length > 0;
}

export {
  listChannelAudienceUserIds,
  SESSION_ROOM_CONTEXT_TYPE,
  OBJECT_ROOM_CONTEXT_TYPES,
  isObjectRoomType,
  type ObjectRoomType,
} from "@synap/database/channel-visibility";
