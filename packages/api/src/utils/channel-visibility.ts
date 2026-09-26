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
export {
  channelVisibilityWhere,
  canUserSeeChannel,
  listChannelAudienceUserIds,
  SESSION_ROOM_CONTEXT_TYPE,
  OBJECT_ROOM_CONTEXT_TYPES,
  isObjectRoomType,
  type ObjectRoomType,
} from "@synap/database/channel-visibility";
