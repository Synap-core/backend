/**
 * Chat Router
 *
 * Re-exports the channels router under the legacy "chat" name.
 * The full implementation lives in channels.ts.
 *
 * The tRPC key "chat" is preserved for backward compatibility with all
 * frontend hooks that use trpc.chat.* (sendMessage, getMessages, etc.)
 */

export { channelsRouter as chatRouter } from "./channels.js";
