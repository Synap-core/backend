/**
 * Canonical channel READ visibility — the SINGLE predicate every channel read
 * scopes by, so scoping lives in one place instead of being hand-rolled per
 * route. A caller may see a channel when ANY of these holds:
 *
 *   1. they OWN it (`channels.userId = me`), OR
 *   2. they are an explicit member (a `channel_members` row), OR
 *   3. it is a SHARED-type channel (external / agent_collab / group) that lives
 *      in a workspace the caller can access (`userVisibleWhere`) — so a client
 *      channel mirrored into a workspace is visible to EVERY workspace member,
 *      WITHOUT exposing other users' private threads / personal channels.
 *
 * Personal / thread / sub_thread / feed channels are deliberately NOT
 * workspace-broadcast — they stay owner-or-member only.
 *
 * Why this is a `custom` access rule and not the flat `workspace` rule: a
 * channel's `workspace_id = NULL` means "personal" (owner-private), but the
 * generic `workspace` VisibilityRule treats a NULL workspace column as a
 * pod-wide GLOBAL (visible to everyone). Using that rule for channels would
 * leak every user's personal channels to the whole pod. This predicate encodes
 * the correct channel semantics instead.
 */
import {
  channels,
  channelMembers,
  ChannelType,
  db,
  eq,
  and,
  or,
  exists,
  inArray,
  drizzleSql,
} from "@synap/database";
import { isNotNull } from "drizzle-orm";
import { userVisibleWhere } from "./user-visible-where.js";

/** Shared-type channels that are visible to all members of their workspace. */
const SHARED_CHANNEL_TYPES = [
  ChannelType.EXTERNAL,
  ChannelType.AGENT_COLLAB,
  ChannelType.GROUP,
] as const;

export function channelVisibilityWhere(userId: string) {
  return or(
    // 1. Own it.
    eq(channels.userId, userId),
    // 2. Explicit member (group/collab channels record membership here).
    exists(
      db
        .select({ one: drizzleSql`1` })
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.channelId, channels.id),
            eq(channelMembers.memberId, userId)
          )
        )
    ),
    // 3. Shared-type channel in a workspace the caller can access. isNotNull
    //    guards the personal-NULL case so userVisibleWhere's pod-wide-global
    //    branch can never broadcast a NULL-workspace channel.
    and(
      inArray(channels.channelType, [...SHARED_CHANNEL_TYPES]),
      isNotNull(channels.workspaceId),
      userVisibleWhere(channels.workspaceId, userId)
    )
  )!;
}
