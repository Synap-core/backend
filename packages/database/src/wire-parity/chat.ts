/**
 * Compile-time contract: the chat unions `@synap-core/types/chat/model`
 * declares are EXACTLY this package's runtime `as const` objects
 * (`ChannelType.THREAD`, …), and the row interfaces it declares (re-exported
 * here as `Channel`, `MessageRow`, `ChannelContextItem`) match their tables.
 * No runtime code.
 *
 * The row interfaces are explicit, not inferred: each `_…Columns` proves every
 * declared field has the column's exact type, and each `_…Withheld` names the
 * columns the wire does NOT carry, so a new column is classified here before
 * the build passes.
 */
import type * as Wire from "@synap-core/types/chat/model";
import type {
  AiReactionMode,
  Channel,
  ChannelAgentType,
  ChannelScope,
  ChannelStatus,
  ChannelType,
  channels,
  FeedScope,
} from "../schema/channels.js";
import type {
  MessageAuthorType,
  MessageCategory,
  MessageRole,
  MessageRow,
  messages,
  RoutedSource,
} from "../schema/messages.js";
import type {
  ChannelContextConflictStatus,
  ChannelContextItem,
  ChannelContextObjectType,
  ChannelContextRelationshipType,
  channelContextItems,
} from "../schema/channel-context-items.js";
import type { Equal } from "./equal.js";

// ── Unions ↔ runtime consts ─────────────────────────────────────────────────

export const _channelType: Equal<ChannelType, Wire.ChannelType> = true;
export const _channelScope: Equal<ChannelScope, Wire.ChannelScope> = true;
export const _feedScope: Equal<FeedScope, Wire.FeedScope> = true;
export const _channelStatus: Equal<ChannelStatus, Wire.ChannelStatus> = true;
export const _channelAgentType: Equal<ChannelAgentType, Wire.ChannelAgentType> =
  true;
export const _aiReactionMode: Equal<AiReactionMode, Wire.AiReactionMode> = true;
export const _messageRole: Equal<MessageRole, Wire.MessageRole> = true;
export const _messageAuthorType: Equal<
  MessageAuthorType,
  Wire.MessageAuthorType
> = true;
export const _messageCategory: Equal<MessageCategory, Wire.MessageCategory> =
  true;
export const _routedSource: Equal<RoutedSource, Wire.RoutedSource> = true;
export const _contextObjectType: Equal<
  ChannelContextObjectType,
  Wire.ChannelContextObjectType
> = true;
export const _contextRelationshipType: Equal<
  ChannelContextRelationshipType,
  Wire.ChannelContextRelationshipType
> = true;
export const _contextConflictStatus: Equal<
  ChannelContextConflictStatus,
  Wire.ChannelContextConflictStatus
> = true;

// ── Row interfaces ↔ tables ─────────────────────────────────────────────────

type ChannelColumns = typeof channels.$inferSelect;
type MessageColumns = typeof messages.$inferSelect;
type ContextItemColumns = typeof channelContextItems.$inferSelect;

/** Columns the wire `Channel` does not carry. */
type ChannelWithheld = never;
/** Columns the wire `MessageRow` does not carry. */
type MessageWithheld = never;
/** Columns the wire `ChannelContextItem` does not carry. */
type ContextItemWithheld = never;

export const _channelColumns: Equal<
  Pick<ChannelColumns, keyof Channel & keyof ChannelColumns>,
  Channel
> = true;
export const _channelWithheld: Equal<
  Exclude<keyof ChannelColumns, keyof Channel>,
  ChannelWithheld
> = true;
export const _messageColumns: Equal<
  Pick<MessageColumns, keyof MessageRow & keyof MessageColumns>,
  MessageRow
> = true;
export const _messageWithheld: Equal<
  Exclude<keyof MessageColumns, keyof MessageRow>,
  MessageWithheld
> = true;
export const _contextItemColumns: Equal<
  Pick<ContextItemColumns, keyof ChannelContextItem & keyof ContextItemColumns>,
  ChannelContextItem
> = true;
export const _contextItemWithheld: Equal<
  Exclude<keyof ContextItemColumns, keyof ChannelContextItem>,
  ContextItemWithheld
> = true;
