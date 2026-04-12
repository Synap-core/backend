/**
 * Feed RSS Executor Worker
 *
 * Processes RSS feed execution jobs.
 * - Fetches RSS items via CP proxy
 * - Filters seen URLs within tracking window
 * - Calls IS for classification (stub if IS not ready)
 * - Filters by relevance score
 * - Posts messages (individual or batch)
 * - Tracks seen URLs
 * - Emits 'feed.execution.completed' event
 */

import { randomUUID } from "crypto";
import { db, eq, and, gte, eventRepository } from "@synap/database";
import { channels, messages, ChannelStatus } from "@synap/database/schema";
import { createLogger, config } from "@synap-core/core";
import { getBoss } from "../boss.js";
import { emitSideEffects } from "../emit-side-effects.js";
import {
  fetchRSSItems,
  type NormalizedRSSItem,
} from "../fetchers/rss-fetcher.js";
import type {
  FeedExecutionPayload,
  RSSFeedConfig,
  FeedMessageMetadata,
} from "@synap/api/types/feed-config";
import { MessageRole, MessageAuthorType } from "@synap/database/schema";
import { createHash } from "crypto";

const logger = createLogger({ module: "feed-rss-executor" });

// ── Types ────────────────────────────────────────────────────────────────────

interface ClassificationResult {
  relevanceScore: number;
  shouldInclude: boolean;
  categories: string[];
  summary?: string;
}

// ── Seen URL Tracking ────────────────────────────────────────────────────────

/**
 * Get set of seen URLs within tracking window.
 */
async function getSeenURLs(
  channelId: string,
  windowDays: number
): Promise<Set<string>> {
  const since = new Date();
  since.setDate(since.getDate() - windowDays);

  const recentMessages = await db.query.messages.findMany({
    where: and(
      eq(messages.channelId, channelId),
      gte(messages.createdAt, since)
    ),
    columns: {
      metadata: true,
    },
  });

  const seen = new Set<string>();

  for (const msg of recentMessages) {
    const metadata = msg.metadata as Record<string, unknown> | null;
    const sourceUrl = metadata?.sourceUrl as string;
    if (sourceUrl) {
      seen.add(sourceUrl);
    }
  }

  return seen;
}

// ── IS Classification ────────────────────────────────────────────────────────

/**
 * Call Intelligence Service to classify RSS items.
 * Returns stub results if IS is not ready/configured.
 */
async function classifyItems(
  items: NormalizedRSSItem[],
  _config: RSSFeedConfig,
  _userId: string,
  _workspaceId?: string
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>();

  // Check if IS is configured
  const isUrl = process.env.INTELLIGENCE_HUB_URL;
  const isApiKey = process.env.INTELLIGENCE_HUB_API_KEY;

  if (!isUrl || !isApiKey) {
    logger.warn("IS not configured, using stub classification");
    // Return default classifications (include all)
    for (const item of items) {
      results.set(item.id, {
        relevanceScore: 50,
        shouldInclude: true,
        categories: item.categories,
      });
    }
    return results;
  }

  // TODO: Implement actual IS classification call
  // For now, use stub that includes all items with basic scoring
  logger.info({ itemCount: items.length }, "Classifying RSS items (stub)");

  for (const item of items) {
    // Simple heuristic scoring based on content length and categories
    const hasContent = item.contentText.length > 100 ? 10 : 0;
    const hasCategories = item.categories.length > 0 ? 10 : 0;
    const baseScore = 50 + hasContent + hasCategories;

    results.set(item.id, {
      relevanceScore: Math.min(100, baseScore),
      shouldInclude: true,
      categories: item.categories,
      summary:
        item.contentText.slice(0, 200) +
        (item.contentText.length > 200 ? "..." : ""),
    });
  }

  return results;
}

// ── Message Posting ──────────────────────────────────────────────────────────

/**
 * Format RSS item as message content.
 */
function formatItemContent(
  item: NormalizedRSSItem,
  classification: ClassificationResult
): string {
  const parts: string[] = [];

  // Title and link
  parts.push(`**[${item.title}](${item.url})**`);
  parts.push("");

  // Source
  parts.push(`*From ${item.source.name}*`);
  parts.push("");

  // Summary if available
  if (classification.summary) {
    parts.push(classification.summary);
    parts.push("");
  } else if (item.contentText) {
    parts.push(
      item.contentText.slice(0, 300) +
        (item.contentText.length > 300 ? "..." : "")
    );
    parts.push("");
  }

  // Categories
  if (classification.categories.length > 0) {
    parts.push(
      `Tags: ${classification.categories.map((c) => `#${c}`).join(" ")}`
    );
  }

  return parts.join("\n");
}

/**
 * Format batch digest of RSS items.
 */
function formatBatchContent(
  items: Array<{
    item: NormalizedRSSItem;
    classification: ClassificationResult;
  }>
): string {
  const parts: string[] = [];

  parts.push(`## 📰 Feed Update — ${items.length} new items`);
  parts.push("");

  for (const { item, classification } of items) {
    parts.push(`### [${item.title}](${item.url})`);
    parts.push(
      `*${item.source.name}* · Relevance: ${classification.relevanceScore}%`
    );

    if (classification.summary) {
      parts.push(classification.summary);
    }

    if (classification.categories.length > 0) {
      parts.push(
        `Tags: ${classification.categories.map((c) => `#${c}`).join(" ")}`
      );
    }

    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Post RSS item(s) as message(s).
 */
async function postRSSItems(
  channelId: string,
  userId: string,
  items: Array<{
    item: NormalizedRSSItem;
    classification: ClassificationResult;
  }>,
  postMode: "individual" | "batch",
  runId: string
): Promise<{ posted: number; messageIds: string[] }> {
  const messageIds: string[] = [];

  if (postMode === "batch" && items.length > 1) {
    // Post as single digest
    const batchId = randomUUID();
    const content = formatBatchContent(items);
    const messageId = randomUUID();
    const hash = createHash("sha256")
      .update(`${messageId}${content}`)
      .digest("hex");

    const metadata: FeedMessageMetadata = {
      feedType: "rss",
      batched: true,
      batchId,
      aiClassified: true,
      sourceUrl: items[0]?.item.source.url,
    };

    await db.insert(messages).values({
      id: messageId,
      channelId,
      userId,
      role: MessageRole.SYSTEM,
      authorType: MessageAuthorType.BOT,
      content,
      hash,
      previousHash: "",
      metadata: {
        ...metadata,
        feedRunId: runId,
        itemCount: items.length,
      },
    });

    messageIds.push(messageId);

    logger.info({ messageId, itemCount: items.length }, "Posted RSS batch");
  } else {
    // Post individually
    for (const { item, classification } of items) {
      const content = formatItemContent(item, classification);
      const messageId = randomUUID();
      const hash = createHash("sha256")
        .update(`${messageId}${content}`)
        .digest("hex");

      const metadata: FeedMessageMetadata = {
        feedType: "rss",
        sourceUrl: item.url,
        sourceItemId: item.id,
        publishedAt: item.publishedAt.toISOString(),
        author: item.author,
        categories: classification.categories,
        relevanceScore: classification.relevanceScore,
        aiClassified: true,
      };

      await db.insert(messages).values({
        id: messageId,
        channelId,
        userId,
        role: MessageRole.SYSTEM,
        authorType: MessageAuthorType.BOT,
        content,
        hash,
        previousHash: "",
        metadata: {
          ...metadata,
          feedRunId: runId,
        },
      });

      messageIds.push(messageId);
    }

    logger.info({ count: items.length }, "Posted RSS items individually");
  }

  return { posted: items.length, messageIds };
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleFeedRSSExecute(job: {
  data: FeedExecutionPayload;
}): Promise<void> {
  const { channelId, userId, workspaceId, config, runId } = job.data;

  logger.info(
    { channelId, runId, sourceCount: config.sources.length },
    "Starting RSS feed execution"
  );

  const startTime = Date.now();
  let itemCount = 0;
  let postedCount = 0;
  let error: string | undefined;

  try {
    // 1. Get seen URLs
    const seenUrls = await getSeenURLs(channelId, config.dedupWindowDays);
    logger.debug({ seenCount: seenUrls.size }, "Loaded seen URLs");

    // 2. Fetch RSS items
    const fetchResult = await fetchRSSItems(config.sources, {
      useCpProxy: config.rsshubConfig?.useCpProxy ?? true,
      maxItems: config.maxItemsPerRun * 2, // Fetch more for filtering
    });

    if (fetchResult.errors.length > 0) {
      logger.warn({ errors: fetchResult.errors }, "Some RSS sources failed");
    }

    // 3. Filter seen URLs
    const newItems = fetchResult.items.filter(
      (item) => !seenUrls.has(item.url)
    );
    logger.info(
      { newItems: newItems.length, fetched: fetchResult.items.length },
      "Filtered seen URLs"
    );

    if (newItems.length === 0) {
      logger.info("No new items to process");
      await updateFeedStatus(
        channelId,
        {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "success",
          lastRunItemCount: 0,
        },
        config
      );
      return;
    }

    // 4. Classify items
    const classifications = await classifyItems(
      newItems,
      config,
      userId,
      workspaceId
    );

    // 5. Filter by relevance score
    const filteredItems = newItems
      .map((item) => ({
        item,
        classification: classifications.get(item.id) || {
          relevanceScore: 0,
          shouldInclude: false,
          categories: [],
        },
      }))
      .filter(({ classification }) => {
        if (!classification.shouldInclude) return false;
        if (config.minRelevanceScore > 0) {
          return classification.relevanceScore >= config.minRelevanceScore;
        }
        return true;
      })
      .slice(0, config.maxItemsPerRun);

    itemCount = filteredItems.length;
    logger.info(
      { filteredCount: itemCount },
      "Items after classification and filtering"
    );

    if (filteredItems.length === 0) {
      logger.info("No items passed classification filter");
      await updateFeedStatus(
        channelId,
        {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "success",
          lastRunItemCount: 0,
        },
        config
      );
      return;
    }

    // 6. Post messages
    const result = await postRSSItems(
      channelId,
      userId,
      filteredItems,
      config.postMode,
      runId
    );
    postedCount = result.posted;

    // 7. Emit side effects
    emitSideEffects({
      subjectType: "feed",
      action: "execution",
      subjectId: runId,
      userId,
      workspaceId,
      data: {
        channelId,
        feedType: "rss",
        itemsFetched: fetchResult.items.length,
        itemsNew: newItems.length,
        itemsPosted: postedCount,
        durationMs: Date.now() - startTime,
      },
    }).catch(() => {});

    // 8. Emit event
    eventRepository
      .append({
        id: randomUUID(),
        version: "v1",
        type: "feed.execution.completed",
        subjectType: "feed",
        subjectId: runId,
        userId,
        source: "system",
        timestamp: new Date(),
        data: {
          channelId,
          feedType: "rss",
          itemsFetched: fetchResult.items.length,
          itemsNew: newItems.length,
          itemsPosted: postedCount,
          durationMs: Date.now() - startTime,
          errors:
            fetchResult.errors.length > 0 ? fetchResult.errors : undefined,
        },
      })
      .catch(() => {});

    // 9. Update feed status
    await updateFeedStatus(
      channelId,
      {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "success",
        lastRunItemCount: postedCount,
      },
      config
    );

    logger.info(
      { runId, durationMs: Date.now() - startTime, posted: postedCount },
      "RSS feed execution complete"
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ err, channelId, runId }, "RSS feed execution failed");

    // Update status with error
    await updateFeedStatus(
      channelId,
      {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "error",
        lastError: error,
      },
      config
    );

    throw err;
  }
}

/**
 * Update feed status in channel metadata.
 */
async function updateFeedStatus(
  channelId: string,
  status: {
    lastRunAt: string;
    lastRunStatus: "success" | "error" | "running";
    lastRunItemCount?: number;
    lastError?: string;
  },
  config: RSSFeedConfig
): Promise<void> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { metadata: true },
  });

  if (!channel) return;

  const metadata = (channel.metadata as Record<string, unknown>) ?? {};
  const currentStatus = (metadata.feedStatus as Record<string, unknown>) ?? {};

  // Calculate next run
  const nextRunAt = calculateNextRun(config.schedule, config.timezone);

  await db
    .update(channels)
    .set({
      metadata: {
        ...metadata,
        feedStatus: {
          ...currentStatus,
          ...status,
          nextRunAt: nextRunAt.toISOString(),
          currentRunId: undefined, // Clear current run
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channelId));
}

/**
 * Calculate next run time from cron expression.
 */
function calculateNextRun(cronExpr: string, timezone: string): Date {
  const now = new Date();

  // Simple implementations for common patterns
  const minuteMatch = cronExpr.match(/^\*\/([0-9]+) \* \* \* \*$/);
  if (minuteMatch) {
    const interval = parseInt(minuteMatch[1], 10);
    const next = new Date(now);
    const currentMinutes = next.getMinutes();
    const nextMinutes = Math.ceil((currentMinutes + 1) / interval) * interval;
    if (nextMinutes >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMinutes - 60);
    } else {
      next.setMinutes(nextMinutes);
    }
    next.setSeconds(0);
    next.setMilliseconds(0);
    return next;
  }

  const hourMatch = cronExpr.match(/^0 \*\/([0-9]+) \* \* \*$/);
  if (hourMatch) {
    const interval = parseInt(hourMatch[1], 10);
    const next = new Date(now);
    const currentHours = next.getHours();
    const nextHours = Math.ceil((currentHours + 1) / interval) * interval;
    if (nextHours >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(0);
    } else {
      next.setHours(nextHours);
    }
    next.setMinutes(0);
    next.setSeconds(0);
    return next;
  }

  const dailyMatch = cronExpr.match(/^0 ([0-9]+) \* \* \*$/);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const next = new Date(now);
    next.setHours(hour);
    next.setMinutes(0);
    next.setSeconds(0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // Default: 6 hours
  const next = new Date(now);
  next.setHours(next.getHours() + 6);
  next.setMinutes(0);
  next.setSeconds(0);
  return next;
}
