/**
 * Thread bootstrap utilities.
 *
 * Personal chat now uses ChannelType.THREAD + ThreadKind.PERSONAL.
 * Proactive posts use ChannelType.FEED + feed metadata.
 */

import { randomUUID, createHash } from "node:crypto";
import { db, eq, and } from "@synap/database";
import {
  channels,
  messages,
  ChannelType,
  ChannelScope,
  FeedScope,
  ThreadKind,
  ChannelStatus,
  ChannelAgentType,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import type { Channel } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "personal-channel" });

/**
 * Static hydration-style greeting seeded on the truly-first-ever personal
 * channel creation. Kept static to avoid first-login latency (no IS call).
 */
const PERSONAL_CHANNEL_WELCOME_MESSAGE = `Hey — I'm your co-founder here. Welcome to your data pod. This is just us — private, yours, forever.

Before I can help well, I want to understand a bit about what's on your plate. No forms, no presets — just a conversation. We'll start with what you're working on right now, then I'll ask about the people, projects, and moments you want to remember. As you talk, I'll quietly start structuring things. You can always import anything you already have — notes, LinkedIn, files, wherever. Ready?`;

/**
 * Seed the first assistant greeting on a freshly-created personal channel.
 * Best-effort: logs and swallows errors so channel creation always succeeds.
 *
 * Uses `authorType: AI_AGENT` and stamps `metadata.agentType = "onboarding"`
 * so downstream surfaces can identify the hydration greeting. Does NOT call
 * the IS — the copy is static to keep first-login fast.
 */
async function seedWelcomeMessage(
  channelId: string,
  userId: string
): Promise<void> {
  try {
    const messageId = randomUUID();
    const hash = createHash("sha256")
      .update(`${messageId}${PERSONAL_CHANNEL_WELCOME_MESSAGE}`)
      .digest("hex");

    // The typed Zod schema for message metadata does not declare an
    // `agentType` slot, but the column is JSONB and several readers already
    // tolerate extra keys. Attach via a narrow local cast rather than
    // widening the shared schema for one seeding path.
    const seedMetadata = { agentType: "onboarding" };

    await db.insert(messages).values({
      id: messageId,
      channelId,
      role: MessageRole.ASSISTANT,
      authorType: MessageAuthorType.AI_AGENT,
      messageCategory: MessageCategory.CHAT,
      content: PERSONAL_CHANNEL_WELCOME_MESSAGE,
      userId,
      previousHash: "",
      hash,
      metadata: seedMetadata as (typeof messages.$inferInsert)["metadata"],
    });
  } catch (err: unknown) {
    logger.error(
      { err, channelId, userId },
      "Failed to seed welcome message on personal channel — continuing"
    );
  }
}

/**
 * Get or create the user's personal thread (pod-wide).
 * Pure user↔AI conversation — no automation outputs here.
 *
 * On the truly-first-ever creation (not the find-existing path) we also seed
 * a single onboarding greeting from the assistant so the channel is never
 * rendered empty.
 */
export async function ensurePersonalChannel(
  userId: string,
  _workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.THREAD),
      eq(channels.threadKind, ThreadKind.PERSONAL),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.THREAD,
      threadKind: ThreadKind.PERSONAL,
      scope: ChannelScope.POD,
      status: ChannelStatus.ACTIVE,
      agentId: "personal",
      agentType: ChannelAgentType.PERSONAL,
    })
    .returning();

  // First-ever creation path — seed the hydration greeting. Best-effort.
  await seedWelcomeMessage(channel.id, userId);

  return channel;
}

/**
 * Get or create the user's proactive FEED channel (pod-wide, user-scoped).
 * AI-initiated posts: morning briefings, event prep, automation summaries.
 * Rate-limited via /api/hub/proactive/post (3/hr, 10/day).
 * User reads, taps to open a conversation — does not type directly here.
 */
export async function ensureProactiveFeedChannel(
  userId: string,
  _workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.FEED),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.FEED,
      scope: ChannelScope.POD,
      feedScope: FeedScope.USER,
      status: ChannelStatus.ACTIVE,
      agentId: "proactive",
      agentType: ChannelAgentType.PERSONAL,
    })
    .returning();

  return channel;
}
