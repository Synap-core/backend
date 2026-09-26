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
 * OBJECT ROOMS FOLLOW THEIR OBJECT (Documents v2, 2026-09-26). An object's ONE
 * linked channel (`channel_type = group`, `context_object_type` in
 * {@link OBJECT_ROOM_CONTEXT_TYPES}, minted only by
 * `ChannelRepository.ensureObjectChannel`) is visible exactly when the OBJECT is
 * visible — branch 5 below evaluates the object's own read floor, REGISTERED by
 * the layer that owns it (`registerObjectRoomFloor`; the api registers the
 * `documents` / `entities` VisibilityRules in `utils/object-room-floors.ts`).
 * Like a session room it is carved OUT of the broadcast branches 3/4: GROUP is
 * a shared type, and without the carve-out a pod-wide document's room would be
 * visible to the whole pod, and a workspace document's room to members the
 * document itself excludes (a project-exposed doc, a private pod-wide doc).
 * An unregistered type FAILS CLOSED: owner (1) and roster (2) only.
 *
 * `userId` may be a literal id OR a column (`users.id`): the realtime audience
 * of a channel is "every user this predicate admits", computed by correlating
 * it against `users` — derived from the rule, never a hand-listed roster. A
 * registered object floor takes a literal id only, so for an object room the
 * audience is completed per user through the same predicate
 * (`listChannelAudienceUserIds`).
 */
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
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
 * The object kinds that own ONE linked channel (an "object room"). Mirrors the
 * partial unique index `channels_object_room_uniq` (migration 0279) — a type
 * added here needs the index widened in the same change.
 */
export const OBJECT_ROOM_CONTEXT_TYPES = ["document", "entity"] as const;
export type ObjectRoomType = (typeof OBJECT_ROOM_CONTEXT_TYPES)[number];

export function isObjectRoomType(value: unknown): value is ObjectRoomType {
  return (
    typeof value === "string" &&
    (OBJECT_ROOM_CONTEXT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * An object's read floor as SQL, correlated to the object id expression it is
 * handed (`channels.context_object_id`). Must admit exactly the rows the
 * object's own read door admits — the api builds it from the registered
 * VisibilityRule, never a copy.
 */
export type ObjectRoomFloor = (userId: string, objectId: AnyColumn) => SQL;

const objectRoomFloors = new Map<ObjectRoomType, ObjectRoomFloor>();

/** Register the read floor an object room of `type` follows (idempotent). */
export function registerObjectRoomFloor(
  type: ObjectRoomType,
  floor: ObjectRoomFloor
): void {
  objectRoomFloors.set(type, floor);
}

/** Is a floor registered for `type`? (Diagnostics + tests.) */
export function hasObjectRoomFloor(type: ObjectRoomType): boolean {
  return objectRoomFloors.has(type);
}

/** The row IS an object room (GROUP + a bindable object stamp). */
function objectRoomWhere(): SQL {
  return and(
    eq(channels.channelType, ChannelType.GROUP),
    inArray(channels.contextObjectType, [...OBJECT_ROOM_CONTEXT_TYPES])
  )!;
}

/** NOT an object room — gates the broadcast branches (3, 4). */
function notObjectRoom(): SQL {
  return or(
    ne(channels.channelType, ChannelType.GROUP),
    isNull(channels.contextObjectType),
    not(inArray(channels.contextObjectType, [...OBJECT_ROOM_CONTEXT_TYPES]))
  )!;
}

/**
 * Branch 5: an object room whose object the caller may read. Literal ids only
 * (see the audience note in the docblock); an unregistered type contributes
 * nothing (fail closed).
 */
function objectRoomBranch(userId: string | AnyColumn): SQL | undefined {
  if (typeof userId !== "string" || objectRoomFloors.size === 0) return;
  const arms = [...objectRoomFloors].map(([type, floor]) =>
    and(
      eq(channels.contextObjectType, type),
      floor(userId, channels.contextObjectId)
    )
  );
  return and(eq(channels.channelType, ChannelType.GROUP), or(...arms));
}

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
      notObjectRoom(),
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
      notSessionRoom(),
      notObjectRoom()
    ),
    // 5. An object room whose OBJECT the caller may read (see the docblock).
    objectRoomBranch(userId)
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
  const base = await correlatedAudience(database, channelId);
  // An object room's branch 5 needs a literal id, so it is completed per user
  // through the SAME predicate (`canUserSeeChannel`). Pods are small; this runs
  // only for object rooms.
  const [room] = await database
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.id, channelId), objectRoomWhere()))
    .limit(1);
  if (!room) return base;
  const seen = new Set(base);
  const everyone = await database.select({ id: users.id }).from(users);
  for (const { id } of everyone) {
    if (seen.has(id)) continue;
    if (await canUserSeeChannel(database, channelId, id)) seen.add(id);
  }
  return [...seen];
}

async function correlatedAudience(
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
