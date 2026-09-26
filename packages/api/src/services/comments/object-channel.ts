/**
 * The object's ONE linked channel, reached by a PERSON or an AGENT — the api
 * door over `ChannelRepository.ensureObjectChannel` (Documents v2, founder
 * model 2026-09-25: every document / entity has one conversation about it).
 *
 * The repository mints race-safely but cannot see the access layer, so every
 * caller that is not a system producer comes through HERE: the object is
 * loaded through its own read floor first (a document through
 * `loadReadableDocument`, an entity through the `entities` VisibilityRule),
 * and an unreadable or missing object answers NOT_FOUND — no id probing, and
 * no room is minted for an object the caller cannot see.
 *
 * The private "Ask AI about this" thread (founder decision V3) is a per-user
 * SUB_THREAD under the object room: private (sub-threads are owner-only in
 * `channelVisibilityWhere`), and AI replies land in it.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  desc,
  eq,
  inArray,
  ChannelRepository,
  resolveProjectPlacement,
} from "@synap/database";
import {
  channels,
  ChannelStatus,
  ChannelType,
  entities,
  agents,
  type Channel,
} from "@synap/database/schema";
import { AccessContext, scopedDb } from "../../access/index.js";
import { loadReadableDocument } from "../../utils/document-edit-access.js";
import type { ObjectRoomType } from "../../utils/channel-visibility.js";
import { randomUUID } from "crypto";

export interface ObjectRef {
  type: ObjectRoomType;
  id: string;
}

type EntityRow = typeof entities.$inferSelect;

/**
 * Throw NOT_FOUND unless `userId` may read the object. Returns the object's
 * workspace (for a caller that needs to stamp one).
 */
export async function assertObjectReadable(
  userId: string,
  ref: ObjectRef
): Promise<{ workspaceId: string | null; ownerId: string }> {
  if (ref.type === "document") {
    const doc = await loadReadableDocument(userId, ref.id);
    if (doc.deletedAt) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
    }
    return { workspaceId: doc.workspaceId ?? null, ownerId: doc.userId };
  }
  const entity = await scopedDb(
    AccessContext.operator({ userId })
  ).findFirst<EntityRow>(entities, { where: eq(entities.id, ref.id) });
  if (!entity || entity.deletedAt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
  }
  return { workspaceId: entity.workspaceId ?? null, ownerId: entity.userId };
}

/** The object's room for a caller who may read the object (minted if absent). */
export async function ensureObjectChannelFor(
  userId: string,
  ref: ObjectRef
): Promise<Channel> {
  await assertObjectReadable(userId, ref);
  const room = await new ChannelRepository(db).ensureObjectChannel(ref);
  if (!room) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Object not found" });
  }
  return room.channel;
}

/**
 * The object's room if one exists — NEVER mints (a read must not write). The
 * caller floors on the object first.
 */
export async function findObjectChannel(
  ref: ObjectRef
): Promise<Channel | null> {
  const row = await db.query.channels.findFirst({
    where: and(
      eq(channels.channelType, ChannelType.GROUP),
      eq(channels.status, ChannelStatus.ACTIVE),
      eq(channels.contextObjectType, ref.type),
      eq(channels.contextObjectId, ref.id)
    ),
  });
  return row ?? null;
}

/**
 * Archive the objects' rooms when the objects are HARD-deleted (lead default:
 * archive, never cascade — the conversation stays readable in history).
 * Idempotent. A soft-deleted entity keeps its room (a restore gets it back);
 * the comment doors refuse a deleted object meanwhile.
 */
export async function archiveObjectChannels(
  type: ObjectRef["type"],
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(channels)
    .set({ status: ChannelStatus.ARCHIVED, updatedAt: new Date() })
    .where(
      and(
        eq(channels.channelType, ChannelType.GROUP),
        eq(channels.status, ChannelStatus.ACTIVE),
        eq(channels.contextObjectType, type),
        inArray(channels.contextObjectId, [...ids])
      )
    );
}

async function orchestratorId(slug?: string): Promise<string | null> {
  const find = async (s: string) =>
    (
      await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.slug, s), eq(agents.active, true)))
        .limit(1)
    )[0]?.id ?? null;
  return (slug ? await find(slug) : null) ?? (await find("orchestrator"));
}

/**
 * The caller's PRIVATE "Ask AI about this" thread for an object (decision V3):
 * a SUB_THREAD of the object room, owned by the caller, stamped with the object
 * so the thread context still hydrates it into the prompt.
 *
 * A legacy per-user THREAD about the same object (the pre-v2 key: user ×
 * workspace × object) is ADOPTED in place — re-parented under the room and
 * retyped — so nobody loses their history with the AI about this object.
 */
export async function ensurePrivateObjectThread(params: {
  userId: string;
  ref: ObjectRef;
  workspaceId?: string | null;
  projectId?: string | null;
  agentSlug?: string;
}): Promise<Channel> {
  const { userId, ref } = params;
  const room = await ensureObjectChannelFor(userId, ref);

  const mine = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.parentChannelId, room.id),
      eq(channels.channelType, ChannelType.SUB_THREAD),
      eq(channels.contextObjectType, ref.type),
      eq(channels.contextObjectId, ref.id),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    orderBy: [desc(channels.updatedAt)],
  });
  if (mine) return mine;

  const legacy = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.THREAD),
      eq(channels.contextObjectType, ref.type),
      eq(channels.contextObjectId, ref.id),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    orderBy: [desc(channels.updatedAt)],
  });
  if (legacy) {
    const [adopted] = await db
      .update(channels)
      .set({
        channelType: ChannelType.SUB_THREAD,
        parentChannelId: room.id,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, legacy.id))
      .returning();
    return adopted;
  }

  // PROJECT LENS — the thread about an entity belongs to that entity's project
  // (rung 4 with one bounded id); a document id is not an entity id.
  const placement = await resolveProjectPlacement(db, {
    userId,
    explicitProjectId: params.projectId ?? null,
    ...(ref.type === "entity" ? { relatedEntityIds: [ref.id] } : {}),
  });

  const [created] = await db
    .insert(channels)
    .values({
      id: randomUUID(),
      userId,
      workspaceId: params.workspaceId ?? room.workspaceId ?? null,
      projectId: placement.projectId,
      parentChannelId: room.id,
      branchPurpose: "Ask AI",
      assignedAgentId: await orchestratorId(params.agentSlug),
      channelType: ChannelType.SUB_THREAD,
      contextObjectType: ref.type,
      contextObjectId: ref.id,
      status: ChannelStatus.ACTIVE,
      metadata: { origin: "object-private-thread" },
    })
    .returning();
  return created;
}
