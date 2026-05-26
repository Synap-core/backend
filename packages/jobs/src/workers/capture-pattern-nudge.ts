/**
 * Capture Pattern Nudge Worker
 *
 * Fires after every capture.complete.completed event. Counts how many
 * entities of each profile type the user has captured in the last 7 days.
 * When a count crosses a nudge threshold for the first time, posts a short
 * automation suggestion to the user's personal channel.
 *
 * Dedup: skips if a nudge for the same (userId, profileSlug, threshold)
 * was already posted in the last 7 days (checked via message metadata).
 *
 * Fire-and-forget — all failures are swallowed.
 */

import type PgBoss from "pg-boss";
import { randomUUID, createHash } from "node:crypto";
import { db, eq, and, gte, isNull } from "@synap/database";
import {
  channels,
  messages,
  entities,
  ChannelType,
  ChannelScope,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { sql } from "drizzle-orm";

const logger = createLogger({ module: "capture-pattern-nudge" });

export const CAPTURE_PATTERN_NUDGE_QUEUE = "capture-pattern-nudge";

/** Capture counts that trigger a nudge. Each threshold fires at most once per 7-day window. */
const NUDGE_THRESHOLDS = [5, 20, 50];

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface CapturePatternNudgeJob {
  userId: string;
  workspaceId: string | null;
  profileSlugs: string[];
}

// ── Personal channel resolution ───────────────────────────────────────────────

async function resolvePersonalChannelId(userId: string): Promise<string> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.PERSONAL),
      eq(channels.status, ChannelStatus.ACTIVE)
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

// ── Count recent captures ─────────────────────────────────────────────────────

async function countRecentCaptures(
  userId: string,
  profileSlug: string
): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MS);
  const rows = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.type, profileSlug),
        gte(entities.createdAt, since),
        isNull(entities.deletedAt)
      )
    );
  return rows[0]?.cnt ?? 0;
}

// ── Dedup check ───────────────────────────────────────────────────────────────

async function nudgeAlreadySent(
  channelId: string,
  profileSlug: string,
  threshold: number
): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const existing = await db.query.messages.findFirst({
    where: and(
      eq(messages.channelId, channelId),
      gte(messages.timestamp, since),
      sql`(metadata->>'source') = 'capture-pattern-nudge'`,
      sql`(metadata->>'profileSlug') = ${profileSlug}`,
      sql`(metadata->>'threshold')::int = ${threshold}`
    ),
    columns: { id: true },
  });
  return !!existing;
}

// ── Message generation ────────────────────────────────────────────────────────

function buildNudgeMessage(profileSlug: string, count: number): string {
  const label =
    count === 1
      ? profileSlug
      : profileSlug === "person"
        ? "people"
        : profileSlug === "company"
          ? "companies"
          : `${profileSlug}s`;

  return `You've captured **${count} ${label}** this week. That's a pattern worth automating — I can watch for new ${label} and automatically tag, route, or link them. Want me to set that up?`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleCapturePatternNudge(
  job: PgBoss.Job<CapturePatternNudgeJob>
): Promise<void> {
  const { userId, profileSlugs } = job.data;

  try {
    const channelId = await resolvePersonalChannelId(userId);

    for (const profileSlug of profileSlugs) {
      const count = await countRecentCaptures(userId, profileSlug);
      const threshold = NUDGE_THRESHOLDS.slice()
        .reverse()
        .find((t) => count >= t);
      if (!threshold) continue;

      const alreadySent = await nudgeAlreadySent(
        channelId,
        profileSlug,
        threshold
      );
      if (alreadySent) continue;

      const content = buildNudgeMessage(profileSlug, count);
      const messageId = randomUUID();
      const hash = createHash("sha256")
        .update(`${messageId}${content}`)
        .digest("hex");

      const metadata = {
        agentType: "orchestrator",
        source: "capture-pattern-nudge",
        profileSlug,
        threshold,
        captureCount: count,
      };

      await db.insert(messages).values({
        id: messageId,
        channelId,
        role: MessageRole.ASSISTANT,
        authorType: MessageAuthorType.AI_AGENT,
        messageCategory: MessageCategory.CHAT,
        content,
        userId,
        previousHash: "",
        hash,
        metadata: metadata as (typeof messages.$inferInsert)["metadata"],
      });

      broadcastMessageCreated({ channelId, messageId, userId });

      logger.info(
        { userId, profileSlug, count, threshold },
        "Capture pattern nudge posted"
      );
    }
  } catch (err) {
    logger.warn({ err, userId }, "capture-pattern-nudge failed (non-fatal)");
  }
}
