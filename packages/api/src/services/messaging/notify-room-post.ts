/**
 * Who hears about a message posted into a room — ONE resolution for every
 * posting door (tRPC `channels.sendMessage`, MCP `synap_post_message`, Hub REST
 * `POST /threads/:id/messages`).
 *
 * WHY (research brief 2026-09-25, M2). Only the tRPC door resolved human
 * @mentions, and it skipped the sender as a self-mention. An agent key's
 * `userId` IS its operator, so an agent writing "@antoine can you check this?"
 * was the operator mentioning themself — silence. The MCP and Hub doors did not
 * look at mentions at all. Founder decision the same day: agents talk to the
 * person in the session's ROOM, so a room post from an agent must be able to
 * reach them.
 *
 * THE RULES (the registry's standing rule — ordinary AI chatter never rings a
 * phone — kept):
 *   - An explicit @mention of a human member → `chat.mention` (push). For an
 *     AGENT-authored post (`agentUserId` set) the operator is NOT the author,
 *     so mentioning them counts.
 *   - An agent's `kind: 'question'` in a SESSION room → `session.needs_you`
 *     (push, once per session window) to the session's owner.
 *   - An agent's `kind: 'update'` (the default) in a session room produces NO
 *     notification (founder decision F, 2026-09-25) — it lives only in the
 *     room and the session's state mark.
 *   - Someone already @mentioned is not told twice about the same post.
 *   - A human's own post notifies only the humans it @mentions (never themself).
 *
 * Side effects only: never throws, never gates the post.
 */
import {
  db,
  channels,
  channelMembers,
  ChannelMemberKind,
  users,
  ChannelType,
  and,
  eq,
  inArray,
} from "@synap/database";
import {
  isObjectRoomType,
  listChannelAudienceUserIds,
} from "../../utils/channel-visibility.js";
import { createLogger } from "@synap-core/core";
import { extractHumanMentionHandles } from "../../utils/agent-handles.js";
import { handleCandidatesFor } from "../../routers/channels/helpers.js";
import { NotificationService } from "../../notifications/NotificationService.js";
import { notifySessionNeedsYou } from "../focus-sessions/notify-needs-you.js";
import { resolveRoomSession } from "./room-session.js";

const logger = createLogger({ module: "notify-room-post" });

export { ROOM_POST_KINDS, type RoomPostKind } from "./room-post-kind.js";
import type { RoomPostKind } from "./room-post-kind.js";

const PREVIEW_MAX = 140;
const preview = (content: string) =>
  content.length > PREVIEW_MAX ? `${content.slice(0, PREVIEW_MAX)}…` : content;

/**
 * THE mention resolution: the plain `@handle`s in `content` that are not agent
 * handles, matched against this channel's HUMAN members by display name, each
 * notified once with `chat.mention`. Returns the member ids notified.
 *
 * `agentUserId` set ⇒ the post is the AGENT's, so no member is excluded as
 * "the sender" — the operator's id equals `senderUserId` and is exactly who an
 * agent mentions. Otherwise the sender is excluded (no self-mention).
 */
export async function notifyHumanMentions(p: {
  channelId: string;
  content: string;
  senderUserId: string;
  agentUserId?: string | null;
  /** The channel's workspace; `undefined` ⇒ read from the channel row. */
  workspaceId?: string | null;
  messageId: string;
}): Promise<string[]> {
  const handles = extractHumanMentionHandles(p.content);
  if (handles.length === 0) return [];
  const notified: string[] = [];
  try {
    const rosterMembers = await db
      .select({ memberId: channelMembers.memberId, name: users.name })
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.memberId))
      .where(
        and(
          eq(channelMembers.channelId, p.channelId),
          eq(channelMembers.memberKind, ChannelMemberKind.HUMAN)
        )
      );
    // An OBJECT ROOM has no roster: its people are everyone who may read the
    // object (the channel read rule, branch 5). A mention there reaches a
    // reader of the document, never someone the document excludes.
    const readers = await objectRoomHumanReaders(p.channelId);
    const humanMembers = [
      ...rosterMembers,
      ...readers.filter(
        (r) => !rosterMembers.some((m) => m.memberId === r.memberId)
      ),
    ];

    const senderName = p.agentUserId
      ? await agentDisplayName(p.agentUserId)
      : (humanMembers.find((m) => m.memberId === p.senderUserId)?.name ??
        "Someone");
    const self = p.agentUserId ? null : p.senderUserId;
    const workspaceId =
      p.workspaceId !== undefined
        ? p.workspaceId
        : ((
            await db.query.channels.findFirst({
              where: eq(channels.id, p.channelId),
              columns: { workspaceId: true },
            })
          )?.workspaceId ?? null);

    for (const member of humanMembers) {
      if (member.memberId === self) continue; // no self-mention
      if (notified.includes(member.memberId)) continue;
      // A member matches a handle when a normalized form of their display
      // name equals one of the mentioned handles.
      const candidates = handleCandidatesFor(member.name);
      if (!handles.some((h) => candidates.has(h))) continue;
      notified.push(member.memberId);
      await NotificationService.create({
        type: "chat.mention",
        userId: member.memberId,
        workspaceId,
        sourceType: "system",
        sourceId: p.channelId,
        data: {
          sender: senderName,
          preview: preview(p.content),
          channelId: p.channelId,
          messageId: p.messageId,
        },
      });
    }
  } catch (err) {
    // Non-fatal — a failed mention notification must never fail the send.
    logger.warn(
      { err, channelId: p.channelId },
      "human @mention notification failed"
    );
  }
  return notified;
}

/**
 * The HUMAN readers of an object room (empty for any other channel) — the
 * channel's own audience rule (`listChannelAudienceUserIds`), never a list.
 */
async function objectRoomHumanReaders(
  channelId: string
): Promise<Array<{ memberId: string; name: string | null }>> {
  const [room] = await db
    .select({
      channelType: channels.channelType,
      contextObjectType: channels.contextObjectType,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (
    !room ||
    room.channelType !== ChannelType.GROUP ||
    !isObjectRoomType(room.contextObjectType)
  ) {
    return [];
  }
  const audience = await listChannelAudienceUserIds(db, channelId);
  if (audience.length === 0) return [];
  return db
    .select({ memberId: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.id, audience), eq(users.userType, "human")));
}

async function agentDisplayName(agentUserId: string): Promise<string> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, agentUserId),
    columns: { name: true },
  });
  return row?.name?.trim() || "An agent";
}

/**
 * Everything a room post owes the people in the room: mentions for any
 * author, and — for an AGENT's `question` post in a session room — the
 * `session.needs_you` push. A plain `update` owes nothing (founder decision
 * F, 2026-09-25). Call AFTER the message row landed (a duplicate/replayed
 * post must not notify again).
 */
export async function notifyRoomPost(p: {
  channelId: string;
  content: string;
  messageId: string;
  /** The authenticated owner (for an agent key: its operator). */
  userId: string;
  agentUserId?: string | null;
  kind?: RoomPostKind;
  /** The channel's workspace; `undefined` ⇒ read from the channel row. */
  workspaceId?: string | null;
}): Promise<void> {
  const mentioned = await notifyHumanMentions({
    channelId: p.channelId,
    content: p.content,
    senderUserId: p.userId,
    agentUserId: p.agentUserId,
    workspaceId: p.workspaceId,
    messageId: p.messageId,
  });
  if (!p.agentUserId) return;

  try {
    // The session whose ROOM this is — the ONE room→session resolution.
    const session = await resolveRoomSession(p.channelId);
    if (!session) return;
    // Already told about THIS post by name — one notification per person.
    if (mentioned.includes(session.userId)) return;

    if (p.kind === "question") {
      await notifySessionNeedsYou({
        sessionId: session.id,
        byAgent: true,
        reason: { kind: "question", text: p.content, channelId: p.channelId },
      });
    }
    // A plain `update` (the default) is NOT a notification (founder decision
    // F, 2026-09-25): it lives in the room and the session's state mark
    // only. There used to be an in-app `session.room_update` row here —
    // removed along with its registry entry; see room-post-kind.ts.
  } catch (err) {
    logger.warn(
      { err, channelId: p.channelId },
      "session room post notification failed"
    );
  }
}
