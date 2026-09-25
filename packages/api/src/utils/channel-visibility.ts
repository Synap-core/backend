/**
 * Canonical channel READ visibility — re-exported from `@synap/database`, where
 * the ONE predicate now lives so the realtime server (which cannot import
 * `@synap/api`) gates `channel:<id>` socket rooms and pushes message content by
 * the SAME rule every read uses. Read the docblock there for the four branches
 * and the roster-only session-room carve-out.
 *
 * Callers keep importing from here (`../utils/channel-visibility.js`); do not
 * re-implement any branch in this package.
 */
export {
  channelVisibilityWhere,
  canUserSeeChannel,
  listChannelAudienceUserIds,
  SESSION_ROOM_CONTEXT_TYPE,
} from "@synap/database/channel-visibility";
