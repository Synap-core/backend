/**
 * Canonical channel READ visibility — the SINGLE predicate every channel read
 * scopes by, so scoping lives in one place instead of being hand-rolled per
 * route. A caller may see a channel when ANY of these holds:
 *
 *   1. they OWN it (`channels.userId = me`), OR
 *   2. they are an explicit member (a `channel_members` row), OR
 *   3. it is a SHARED-type channel (external / agent_collab / group) that lives
 *      in a workspace the caller BELONGS to (member of, or owner of) — so a
 *      client channel mirrored into a workspace is visible to everyone who
 *      actually belongs to that workspace, WITHOUT exposing other users'
 *      private threads / personal channels, OR
 *   4. it is a SHARED-type channel with a NULL workspace — a "pod-wide-shared"
 *      channel (e.g. a Discord bridge inbound not pinned to any single
 *      workspace). A NULL-workspace SHARED channel is a genuine pod-wide global
 *      (team-visible), distinguished from a personal NULL-workspace channel
 *      purely by channelType — personal channels stay branch-1 owner-only.
 *
 * Branch 3 deliberately does NOT use `userVisibleWhere` — that helper also
 * matches pod-visible workspaces, which would leak shared channels to pod-wide
 * bystanders who aren't workspace members. Channel visibility is membership-
 * gated, not discoverability-gated.
 *
 * Personal / thread / sub_thread / feed channels are deliberately NOT
 * workspace-broadcast — they stay owner-or-member only.
 *
 * SESSION ROOMS ARE ROSTER-ONLY, whatever their type. A focus session's room
 * (`contextObjectType = 'focus_session'`, stamped at insert by the one mint,
 * `ensureSessionChannel`) is a GROUP room since 2026-09-24 so several humans
 * and agents can work in it — but GROUP is a SHARED type, so without this
 * carve-out branches 3/4 would hand every session room to the whole workspace,
 * and a pod-scoped (NULL-workspace) one to the WHOLE POD. A session room is
 * visible to its owner (1) and its roster (2, `channel_members`) only.
 *
 * Why the context stamp and not `focus_sessions.channel_id`: a session may
 * BORROW an existing channel (`createSession({ channelId })`, a playbook run's
 * `targetChannelId`) — a client's team channel, the chat a session started in.
 * Keying on the FK would silently narrow those shared channels to the owner.
 * The stamp is written only by the mint, atomically with the row, so it is
 * true for every minted session room from its first instant and for nothing
 * else. Migration 0273 converts exactly the rows carrying it.
 *
 * Why this is a `custom` access rule and not the flat `workspace` rule: for the
 * non-shared channel types a channel's `workspace_id = NULL` means "personal"
 * (owner-private), but the generic `workspace` VisibilityRule treats a NULL
 * workspace column as a pod-wide GLOBAL (visible to everyone). Using that rule
 * for channels would leak every user's personal channels to the whole pod. This
 * predicate encodes the correct channel semantics instead: only branch 4's
 * SHARED-type NULL-workspace channels are pod-wide, never personal ones.
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
import { isNotNull, isNull, ne } from "drizzle-orm";
import { workspaceMembers, workspaces } from "@synap/database/schema";

/** Shared-type channels that are visible to all members of their workspace. */
const SHARED_CHANNEL_TYPES = [
  ChannelType.EXTERNAL,
  ChannelType.AGENT_COLLAB,
  ChannelType.GROUP,
] as const;

/** The `contextObjectType` the session-room mint stamps — the roster-only key. */
export const SESSION_ROOM_CONTEXT_TYPE = "focus_session";

/**
 * NOT a session room. Gates the two broadcast branches (3, 4) so a session room
 * is reachable only through ownership or the roster.
 */
function notSessionRoom() {
  return or(
    isNull(channels.contextObjectType),
    ne(channels.contextObjectType, SESSION_ROOM_CONTEXT_TYPE)
  );
}

export function channelVisibilityWhere(userId: string) {
  // Workspace membership subquery — reused by branch 3.
  const memberOfWs = db
    .select({ one: drizzleSql`1` })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, channels.workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );
  const ownerOfWs = db
    .select({ one: drizzleSql`1` })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, channels.workspaceId),
        eq(workspaces.ownerId, userId)
      )
    );

  return or(
    // 1. Own it.
    eq(channels.userId, userId),
    // 2. Explicit member (recorded in channel_members).
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
    // 3. Shared-type channel in a workspace the caller belongs to (member OR
    //    owner — NOT pod-visible, which would leak channels to bystanders).
    and(
      inArray(channels.channelType, [...SHARED_CHANNEL_TYPES]),
      isNotNull(channels.workspaceId),
      notSessionRoom(),
      or(exists(memberOfWs), exists(ownerOfWs))
    ),
    // 4. Pod-wide-shared: a SHARED-type channel with a NULL workspace. Wave-3
    //    lets a Discord inbound be created "pod-wide" (workspaceId = NULL); on a
    //    TEAM pod that must be team-visible, not owner-private. A NULL-workspace
    //    SHARED channel is a genuine pod-wide global — mirrors how
    //    `userVisibleWhere` treats a NULL workspace as visible to everyone. The
    //    channelType gate keeps personal NULL-workspace channels (branch 1)
    //    owner-only, so no personal thread leaks.
    and(
      isNull(channels.workspaceId),
      inArray(channels.channelType, [...SHARED_CHANNEL_TYPES]),
      notSessionRoom()
    )
  )!;
}
