/**
 * Canonical channel READ visibility — the SINGLE predicate every channel read
 * scopes by, AND the one realtime delivery scopes by (who may join a
 * `channel:<id>` socket room, who a message is pushed to). It lives here, below
 * both `@synap/api` and `@synap/realtime`, because the realtime server cannot
 * import the api package; `@synap/api` re-exports it from
 * `utils/channel-visibility.ts` (the precedent is `podMemberWhere`). A second
 * copy anywhere would be a second rule.
 *
 * A caller may see a channel when ANY of these holds:
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
 *
 * `userId` may be a literal id OR a column (`users.id`): the realtime audience
 * of a channel is "every user this predicate admits", computed by correlating
 * it against `users` — derived from the rule, never a hand-listed roster.
 */
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql as drizzleSql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { channels, channelMembers, ChannelType } from "../schema/channels.js";
import { workspaceMembers, workspaces } from "../schema/workspaces.js";
import { users } from "../schema/users.js";
import type { db as Db } from "../client-pg.js";

/** Shared-type channels that are visible to all members of their workspace. */
const SHARED_CHANNEL_TYPES = [
  ChannelType.EXTERNAL,
  ChannelType.AGENT_COLLAB,
  ChannelType.GROUP,
] as const;

/** The `contextObjectType` the session-room mint stamps — the roster-only key. */
export const SESSION_ROOM_CONTEXT_TYPE = "focus_session";

/** Subqueries only — never executed on their own, so no client is needed. */
const qb = new QueryBuilder();

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

export function channelVisibilityWhere(userId: string | AnyColumn): SQL {
  // Workspace membership subquery — reused by branch 3.
  const memberOfWs = qb
    .select({ one: drizzleSql`1` })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, channels.workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );
  const ownerOfWs = qb
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
      qb
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

/** `db` from this package, or a test's PGlite drizzle handle (cast). */
type SelectDb = Pick<typeof Db, "select">;

/** Can `userId` read channel `channelId`? The realtime `channel:<id>` join gate. */
export async function canUserSeeChannel(
  database: SelectDb,
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

/**
 * Every user who may read channel `channelId` — the realtime AUDIENCE of its
 * content. Correlates {@link channelVisibilityWhere} against `users`, so the set
 * is exactly the read rule's, by construction.
 */
export async function listChannelAudienceUserIds(
  database: SelectDb,
  channelId: string
): Promise<string[]> {
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(
      exists(
        qb
          .select({ one: drizzleSql`1` })
          .from(channels)
          .where(
            and(eq(channels.id, channelId), channelVisibilityWhere(users.id))
          )
      )
    );
  return rows.map((r) => r.id);
}
