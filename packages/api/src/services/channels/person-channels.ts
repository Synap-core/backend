/**
 * A person's channels — the conversations the pod holds with one record
 * (channels wave, lane A, design d00cd2ac §6). ONE read for every door that
 * shows them: Hub `GET /entities/:id/channels`, `GET /channels/:id/proposed-
 * messages` and MCP `synap_get_channel` with `entityId`.
 *
 * Every row is read through the caller's floor AND the calling key's grant:
 *   - the record: `entityReadVisibleWhere` (a record the caller cannot read is
 *     `not_found`, never an empty list that would read "no conversation");
 *   - its channels: `channelVisibilityWhere` (a channel bound to a person
 *     follows the person, access/grant-read.ts `channelFollowsEntityWhere`);
 *   - their messages: the one history door (`queryChannelMessages`), on a
 *     channel the floor above already admitted;
 *   - the proposed messages: `proposalUserFloor` (floor + `proposal` grant).
 *
 * A proposed message is the pending `messaging.external.send` PROPOSAL filed
 * for the channel (`data.channelId`, founder decision 1), never a message row.
 * Until the send door writes `data.channelId` (lane D) there are none.
 */

import {
  db,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  channelMembers,
  channels,
  entities,
  messages,
  proposals,
  users,
} from "@synap/database/schema";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { queryChannelMessages } from "../../utils/query-channel-messages.js";
import { proposalUserFloor } from "../../routers/proposals/scope-conditions.js";
import { openLink } from "../../utils/deep-links.js";

/** The proposal type a proposed message is. */
export const PROPOSED_MESSAGE_TYPE = "messaging.external.send";

/** How much of the last message a channel row carries. */
const LAST_MESSAGE_CHARS = 200;

export interface PodChannelLastMessage {
  content: string;
  at: string;
  direction: "inbound" | "outbound" | null;
}

/** One conversation with a person (design §6 `PodChannel`). */
export interface PodChannel {
  id: string;
  /** The outside tool (linkedin, email, discord, …). */
  provider: string | null;
  /** The person's connected account it goes through, when the tool has one. */
  accountId: string | null;
  title: string | null;
  /** The tool's chat id; null until the first send opens the chat. */
  externalId: string | null;
  participant: { name: string | null; externalId: string | null };
  lastMessage: PodChannelLastMessage | null;
  /** Inbound messages after the last outbound one and the caller's last read. */
  unread: number;
  /** Pending proposed messages the caller can read. */
  pendingProposals: number;
}

export interface ProposedMessage {
  proposalId: string;
  text: string;
  createdAt: string;
  draftedBy: { agentUserId: string; name: string | null } | null;
  reviewUrl: string;
}

export type PersonChannelsResult =
  | { status: "ok"; entityId: string; channels: PodChannel[] }
  | { status: "not_found" };

export type ProposedMessagesResult =
  | { status: "ok"; channelId: string; proposed: ProposedMessage[] }
  | { status: "not_found" };

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/** The pending proposed messages of a channel, through the proposal floor. */
function proposedOnChannelWhere(userId: string, channelId: string) {
  return and(
    eq(proposals.proposalType, PROPOSED_MESSAGE_TYPE),
    eq(proposals.status, "pending"),
    drizzleSql`(${proposals.data} ->> 'channelId') = ${channelId}`,
    proposalUserFloor(userId)
  );
}

async function lastMessage(
  database: typeof db,
  channelId: string
): Promise<PodChannelLastMessage | null> {
  // The channel was admitted by the floor above: the door trusts that gate.
  const [m] = await queryChannelMessages<{
    content: string;
    timestamp: Date;
    direction: "inbound" | "outbound" | null;
  }>(database, {
    channelId,
    order: "desc",
    limit: 1,
    columns: { content: true, timestamp: true, direction: true },
  });
  if (!m) return null;
  return {
    content: m.content.slice(0, LAST_MESSAGE_CHARS),
    at: iso(m.timestamp),
    direction: m.direction ?? null,
  };
}

/**
 * Inbound messages the person has not answered or read: after the latest
 * outbound message, after the caller's read marker, and none once the channel
 * was marked read (`metadata.unread === false`, POST /messaging/channels/:id/
 * mark-read) with no inbound message since.
 */
async function unreadCount(
  database: typeof db,
  channelId: string,
  userId: string,
  markedRead: boolean
): Promise<number> {
  if (markedRead) return 0;
  const [lastOut] = await database
    .select({ at: messages.timestamp })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.direction, "outbound"),
        isNull(messages.deletedAt)
      )
    )
    .orderBy(desc(messages.timestamp))
    .limit(1);
  const [member] = await database
    .select({ at: channelMembers.lastReadAt })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberId, userId)
      )
    )
    .limit(1);
  const marks = [lastOut?.at, member?.at].filter(
    (d): d is Date => d instanceof Date
  );
  const since = marks.length
    ? new Date(Math.max(...marks.map((d) => d.getTime())))
    : null;
  const [row] = await database
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.direction, "inbound"),
        isNull(messages.deletedAt),
        eq(messages.ephemeral, false),
        since ? gt(messages.timestamp, since) : undefined
      )
    );
  return Number(row?.n ?? 0);
}

/**
 * The external channels of one record the caller can read, newest first.
 * `not_found` when the caller cannot read the record itself.
 */
export async function listPersonChannels(
  args: { userId: string; entityId: string },
  database: typeof db = db
): Promise<PersonChannelsResult> {
  const { userId, entityId } = args;
  const [person] = await database
    .select({ id: entities.id, title: entities.title })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(userId)
      )
    )
    .limit(1);
  if (!person) return { status: "not_found" };

  const rows = await database
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.contextObjectType, "entity"),
        eq(channels.contextObjectId, entityId),
        eq(channels.channelType, "external"),
        eq(channels.status, "active"),
        channelVisibilityWhere(userId)
      )
    )
    .orderBy(desc(channels.updatedAt), asc(channels.id));

  const out: PodChannel[] = [];
  for (const ch of rows) {
    const meta = (ch.metadata ?? {}) as Record<string, unknown>;
    const [pending] = await database
      .select({ n: count() })
      .from(proposals)
      .where(proposedOnChannelWhere(userId, ch.id));
    out.push({
      id: ch.id,
      provider: ch.externalSource ?? null,
      accountId: str(meta.accountId),
      title: ch.title ?? person.title ?? null,
      externalId: ch.externalId ?? null,
      participant: {
        name: person.title ?? str(meta.participantName),
        externalId: str(meta.participantExternalId),
      },
      lastMessage: await lastMessage(database, ch.id),
      unread: await unreadCount(database, ch.id, userId, meta.unread === false),
      pendingProposals: Number(pending?.n ?? 0),
    });
  }
  return { status: "ok", entityId, channels: out };
}

/**
 * A channel's pending proposed messages, oldest first. `not_found` when the
 * caller cannot read the channel.
 */
export async function listProposedMessages(
  args: { userId: string; channelId: string },
  database: typeof db = db
): Promise<ProposedMessagesResult> {
  const { userId, channelId } = args;
  const [channel] = await database
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.id, channelId), channelVisibilityWhere(userId)))
    .limit(1);
  if (!channel) return { status: "not_found" };

  const rows = await database
    .select({
      id: proposals.id,
      data: proposals.data,
      createdAt: proposals.createdAt,
      agentUserId: proposals.agentUserId,
      agentName: users.name,
    })
    .from(proposals)
    .leftJoin(users, eq(users.id, proposals.agentUserId))
    .where(proposedOnChannelWhere(userId, channelId))
    .orderBy(asc(proposals.createdAt), asc(proposals.id));

  return {
    status: "ok",
    channelId,
    proposed: rows.map((r) => {
      const data = (r.data ?? {}) as Record<string, unknown>;
      return {
        proposalId: r.id,
        text: str(data.body) ?? str(data.content) ?? str(data.text) ?? "",
        createdAt: iso(r.createdAt),
        draftedBy: r.agentUserId
          ? { agentUserId: r.agentUserId, name: r.agentName ?? null }
          : null,
        reviewUrl: openLink(r.id),
      };
    }),
  };
}
