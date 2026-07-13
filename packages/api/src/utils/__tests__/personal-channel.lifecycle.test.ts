import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  eq,
  drizzleSql,
  agents,
  channels,
  channelMembers,
  messages,
  sessions,
  ChannelMemberKind,
  ChannelMemberRole,
  ChannelStatus,
  ChannelType,
  SessionStatus,
} from "@synap/database";
import {
  closePersonalConversation,
  isTemplatePersonalChannel,
  listPersonalConversationHistory,
  reopenPersonalConversation,
  startNewPersonalConversation,
} from "../personal-channel.js";

const userId = randomUUID();
const agentId = randomUUID();
const agentSlug = `personal-lifecycle-${randomUUID()}`;
let dbAvailable = false;

async function canReachDatabase(): Promise<boolean> {
  try {
    await db
      .select({ one: drizzleSql`1` })
      .from(agents)
      .limit(1);
    return true;
  } catch {
    return false;
  }
}

describe("Personal conversation lifecycle", () => {
  beforeAll(async () => {
    dbAvailable = await canReachDatabase();
    if (!dbAvailable) return;

    await db.insert(agents).values({
      id: agentId,
      name: "Personal lifecycle test agent",
      slug: agentSlug,
      ownerType: "system",
      active: true,
      capabilities: [],
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(channels).where(eq(channels.userId, userId));
    await db.delete(agents).where(eq(agents.id, agentId));
  });

  it("distinguishes template Personal conversations from instance threads", () => {
    expect(
      isTemplatePersonalChannel({
        channelType: ChannelType.PERSONAL,
        assignedAgentId: agentId,
        metadata: null,
      })
    ).toBe(true);
    expect(
      isTemplatePersonalChannel({
        channelType: ChannelType.PERSONAL,
        assignedAgentId: agentId,
        metadata: { agentInstanceThread: true },
      })
    ).toBe(false);
  });

  it("archives the current conversation, closes sessions, and reopens history without changing its state", async () => {
    if (!dbAvailable) return;

    const first = await startNewPersonalConversation(userId, agentId);
    expect(first.archivedChannelIds).toEqual([]);

    const welcomeMessages = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.channelId, first.channel.id));
    expect(welcomeMessages).toEqual([]);

    await db
      .update(channels)
      .set({ agentConfig: { personality: "calm" } })
      .where(eq(channels.id, first.channel.id));
    await db.insert(channelMembers).values({
      id: randomUUID(),
      channelId: first.channel.id,
      memberId: userId,
      memberKind: ChannelMemberKind.HUMAN,
      role: ChannelMemberRole.OWNER,
      addedBy: userId,
    });
    await db.insert(messages).values({
      id: randomUUID(),
      channelId: first.channel.id,
      role: "user",
      content: "Plan the next launch milestone",
      userId,
      previousHash: "",
      hash: randomUUID(),
    });
    const [firstSession] = await db
      .insert(sessions)
      .values({ channelId: first.channel.id, status: SessionStatus.ACTIVE })
      .returning({ id: sessions.id });

    const second = await startNewPersonalConversation(userId, agentId);
    expect(second.archivedChannelIds).toEqual([first.channel.id]);

    const [archivedFirst] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, first.channel.id));
    expect(archivedFirst?.status).toBe(ChannelStatus.ARCHIVED);
    const [closedSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, firstSession.id));
    expect(closedSession?.status).toBe(SessionStatus.CLOSED);

    const history = await listPersonalConversationHistory(
      userId,
      agentId,
      10,
      0
    );
    expect(history.map((item) => item.channel.id)).toEqual([first.channel.id]);
    expect(history[0]).toMatchObject({
      title: "Plan the next launch milestone",
      preview: "Plan the next launch milestone",
      messageCount: 1,
    });
    expect(history[0]?.lastActivity).toBeInstanceOf(Date);

    const reopened = await reopenPersonalConversation(userId, first.channel.id);
    expect(reopened?.archivedChannelIds).toEqual([second.channel.id]);
    expect(reopened?.channel.id).toBe(first.channel.id);
    const [reopenedRow] = await db
      .select({ agentConfig: channels.agentConfig })
      .from(channels)
      .where(eq(channels.id, first.channel.id));
    expect(reopenedRow?.agentConfig).toEqual({ personality: "calm" });

    const [reopenedMember] = await db
      .select({ role: channelMembers.role })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, first.channel.id));
    expect(reopenedMember?.role).toBe(ChannelMemberRole.OWNER);

    const [reopenedSession] = await db
      .insert(sessions)
      .values({ channelId: first.channel.id, status: SessionStatus.ACTIVE })
      .returning({ id: sessions.id });

    const closed = await closePersonalConversation(userId, first.channel.id);
    expect(closed?.status).toBe(ChannelStatus.ARCHIVED);
    const [sessionClosedByClose] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, reopenedSession.id));
    expect(sessionClosedByClose?.status).toBe(SessionStatus.CLOSED);
  });
});
