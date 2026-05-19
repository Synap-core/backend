/**
 * CRM Daily Digest Worker
 *
 * Posts a morning summary of pending conversations and overdue follow-ups
 * to users who have connected messaging accounts with linked unread threads.
 *
 * Architecture:
 *   - Triggered by pg-boss cron at 08:55 UTC daily (fires before most users' workday)
 *   - Queries channel metadata cache — no Unipile API calls (O(1) DB query)
 *   - Only posts if there is something actionable to report
 *   - Posts to the user's personal channel using the same pattern as hydration-summary-post
 *   - Realtime broadcast so the message appears immediately if the user is online
 *
 * The unread flag in channel.metadata is set by webhooks-inbound.ts on every
 * inbound message and cleared by POST /messaging/channels/:id/mark-read.
 */

import type PgBoss from "pg-boss";
import { randomUUID, createHash } from "node:crypto";
import { db, eq, and, lt, ne } from "@synap/database";
import {
  channels,
  messages,
  messagingAccounts,
  entities,
  ChannelType,
  ChannelScope,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "crm-daily-digest" });

export const CRM_DAILY_DIGEST_QUEUE = "crm-daily-digest";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChannelMetadata {
  participantName?: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  unread?: boolean;
}

// ── Personal channel resolution (mirrors hydration-summary-post) ──────────────

async function resolvePersonalChannelId(userId: string): Promise<string> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.PERSONAL)
    ),
    columns: { id: true },
  });
  if (existing) return existing.id;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null,
      channelType: ChannelType.PERSONAL,
      scope: ChannelScope.POD,
      status: ChannelStatus.ACTIVE,
      senderAgentId: null,
    })
    .returning({ id: channels.id });
  return channel.id;
}

// ── Realtime broadcast ────────────────────────────────────────────────────────

function broadcastMessageCreated(options: {
  channelId: string;
  messageId: string;
  userId: string;
}): void {
  const url = `${process.env.REALTIME_URL || "http://localhost:4001"}/bridge/emit`;
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.BRIDGE_SECRET
        ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
        : {}),
    },
    body: JSON.stringify({
      event: "message:created",
      data: {
        channelId: options.channelId,
        messageId: options.messageId,
        userId: options.userId,
      },
      channelId: options.channelId,
      userId: options.userId,
    }),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

// ── Briefing content ──────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  gmail: "Gmail",
  instagram: "Instagram",
  messenger: "Messenger",
  twitter: "Twitter",
  slack: "Slack",
};

interface UnreadThread {
  participantName: string;
  provider: string;
  preview: string;
}

interface OverdueFollowUp {
  title: string;
  daysOverdue: number;
}

function buildDigestContent(
  unreadThreads: UnreadThread[],
  overdueFollowUps: OverdueFollowUp[]
): string | null {
  if (unreadThreads.length === 0 && overdueFollowUps.length === 0) return null;

  const lines: string[] = [
    "**Good morning. Here's what needs your attention today:**\n",
  ];

  if (unreadThreads.length > 0) {
    lines.push(
      `**${unreadThreads.length} message${unreadThreads.length === 1 ? "" : "s"} waiting:**`
    );
    for (const t of unreadThreads) {
      const platform = PLATFORM_LABELS[t.provider] ?? t.provider;
      const preview = t.preview ? ` — *${t.preview.slice(0, 80)}*` : "";
      lines.push(`• **${t.participantName}** (${platform})${preview}`);
    }
    lines.push("");
  }

  if (overdueFollowUps.length > 0) {
    lines.push(
      `**${overdueFollowUps.length} overdue follow-up${overdueFollowUps.length === 1 ? "" : "s"}:**`
    );
    for (const f of overdueFollowUps) {
      const label =
        f.daysOverdue === 1 ? "1 day overdue" : `${f.daysOverdue} days overdue`;
      lines.push(`• **${f.title}** — ${label}`);
    }
  }

  return lines.join("\n");
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function getUnreadThreadsForUser(
  userId: string
): Promise<UnreadThread[]> {
  const linked = await db.query.channels.findMany({
    where: and(
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.contextObjectType, "entity"),
      drizzleSql`${channels.metadata}->>'unread' = 'true'`
    ),
    columns: { metadata: true, externalSource: true },
  });

  // Only include channels owned by (or accessible to) this user's accounts
  const userAccounts = await db.query.messagingAccounts.findMany({
    where: and(
      eq(messagingAccounts.userId, userId),
      eq(messagingAccounts.status, "connected")
    ),
    columns: { provider: true, externalId: true },
  });
  const userProviders = new Set(userAccounts.map((a) => a.provider));

  return linked
    .filter((ch) => userProviders.has(ch.externalSource ?? ""))
    .map((ch) => {
      const meta = (ch.metadata ?? {}) as ChannelMetadata;
      return {
        participantName: meta.participantName ?? "Unknown",
        provider: ch.externalSource ?? "",
        preview: meta.lastMessagePreview ?? "",
      };
    });
}

async function getOverdueFollowUpsForUser(
  userId: string,
  limit = 5
): Promise<OverdueFollowUp[]> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const overdue = await db.query.entities.findMany({
    where: and(
      eq(entities.userId, userId),
      eq(entities.type, "person"),
      drizzleSql`${entities.properties}->>'nextFollowUpDate' IS NOT NULL`,
      drizzleSql`(${entities.properties}->>'nextFollowUpDate')::timestamptz < ${todayStart.toISOString()}`
    ),
    columns: { title: true, properties: true },
    limit,
    orderBy: drizzleSql`(${entities.properties}->>'nextFollowUpDate')::timestamptz ASC`,
  });

  return overdue.map((e) => {
    const followUpDate = new Date(
      (e.properties as Record<string, unknown>)?.nextFollowUpDate as string
    );
    const daysOverdue = Math.max(
      1,
      Math.round((todayStart.getTime() - followUpDate.getTime()) / 86_400_000)
    );
    return { title: e.title ?? "Unnamed contact", daysOverdue };
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleCrmDailyDigest(_job: PgBoss.Job): Promise<void> {
  // Get all users with at least one connected messaging account
  const activeAccounts = await db.query.messagingAccounts.findMany({
    where: eq(messagingAccounts.status, "connected"),
    columns: { userId: true },
  });

  const uniqueUserIds = [...new Set(activeAccounts.map((a) => a.userId))];
  logger.info(
    { count: uniqueUserIds.length },
    "CRM daily digest: processing users"
  );

  for (const userId of uniqueUserIds) {
    try {
      const [unreadThreads, overdueFollowUps] = await Promise.all([
        getUnreadThreadsForUser(userId),
        getOverdueFollowUpsForUser(userId),
      ]);

      const content = buildDigestContent(unreadThreads, overdueFollowUps);
      if (!content) continue; // Nothing to report for this user

      const channelId = await resolvePersonalChannelId(userId);
      const messageId = randomUUID();
      const hash = createHash("sha256")
        .update(`${messageId}${content}`)
        .digest("hex");

      await db.insert(messages).values({
        id: messageId,
        channelId,
        role: MessageRole.ASSISTANT,
        authorType: MessageAuthorType.AGENT,
        category: MessageCategory.PROACTIVE,
        content,
        contentHash: hash,
        metadata: {
          agentType: "orchestrator",
          source: "crm-daily-digest",
          unreadCount: unreadThreads.length,
          overdueCount: overdueFollowUps.length,
        },
      });

      broadcastMessageCreated({ channelId, messageId, userId });

      logger.info(
        {
          userId,
          unread: unreadThreads.length,
          overdue: overdueFollowUps.length,
        },
        "CRM daily digest posted"
      );
    } catch (err) {
      logger.error(
        { err, userId },
        "CRM daily digest failed for user — skipping"
      );
    }
  }
}
