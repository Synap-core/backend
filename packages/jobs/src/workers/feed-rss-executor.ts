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
 *
 * Enhanced with:
 * - Comprehensive try-catch around RSS fetch with fallback
 * - Try-catch around IS calls with fallback
 * - Partial success handling
 * - Detailed error logging with context
 */

import { randomUUID } from "crypto";
import { db, eq, and, gte, eventRepository } from "@synap/database";
import { channels, messages } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import {
  fetchRSSItems,
  type NormalizedRSSItem,
} from "../fetchers/rss-fetcher.js";
import type {
  FeedExecutionPayload,
  RSSFeedConfig,
  FeedMessageMetadata,
} from "@synap/shared-utils";
import { MessageRole, MessageAuthorType } from "@synap/database/schema";
import { createHash } from "crypto";
import { calculateNextRun } from "../utils/feed-helpers.js";
import { withRetry, FEED_RETRY_OPTIONS } from "@synap/shared-utils";

const logger = createLogger({ module: "feed-rss-executor" });

// ── Type Guards ───────────────────────────────────────────────────────────────

function isRSSFeedConfig(
  config: FeedExecutionPayload["config"]
): config is RSSFeedConfig {
  return config.feedType === "rss";
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ClassificationResult {
  relevanceScore: number;
  shouldInclude: boolean;
  categories: string[];
  summary?: string;
}

interface ClassifiedItem extends NormalizedRSSItem {
  topics: string[];
  relevanceScore: number;
  aiClassified: boolean;
}

interface ExecutionResult {
  success: boolean;
  itemsFetched: number;
  itemsNew: number;
  itemsPosted: number;
  errors: string[];
  partialSuccess: boolean;
}

// ── Seen URL Tracking ────────────────────────────────────────────────────────

/**
 * Get set of seen URLs within tracking window.
 * Includes fallback for database errors.
 */
async function getSeenURLs(
  channelId: string,
  windowDays: number
): Promise<Set<string>> {
  try {
    const since = new Date();
    since.setDate(since.getDate() - windowDays);

    const recentMessages = await db.query.messages.findMany({
      where: and(
        eq(messages.channelId, channelId),
        gte(messages.timestamp, since)
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
  } catch (error) {
    logger.error(
      { error, channelId, windowDays },
      "Failed to load seen URLs, using empty set"
    );
    // Fallback: empty set (will process all items)
    return new Set<string>();
  }
}

// ── IS Classification ────────────────────────────────────────────────────────

/**
 * Normalize relevance score to 0-100 range.
 */
function normalizeRelevanceScore(score: number): number {
  // Assume IS returns 0-1, convert to 0-100
  if (score <= 1) return Math.round(score * 100);
  return Math.min(100, Math.max(0, score));
}

/**
 * Extract basic topics from text using simple keyword extraction.
 */
function extractBasicTopics(text: string): string[] {
  const topics: string[] = [];
  const lowerText = text.toLowerCase();

  // Common tech/business topics
  const keywordMap: Record<string, string> = {
    ai: "AI",
    "artificial intelligence": "AI",
    machinelearning: "Machine Learning",
    "machine learning": "Machine Learning",
    startup: "Startups",
    funding: "Funding",
    investment: "Investment",
    blockchain: "Blockchain",
    crypto: "Crypto",
    web3: "Web3",
    software: "Software",
    cloud: "Cloud",
    security: "Security",
    data: "Data",
    analytics: "Analytics",
    product: "Product",
    design: "Design",
    marketing: "Marketing",
    sales: "Sales",
    strategy: "Strategy",
  };

  for (const [keyword, topic] of Object.entries(keywordMap)) {
    if (lowerText.includes(keyword)) {
      if (!topics.includes(topic)) {
        topics.push(topic);
      }
    }
  }

  return topics.slice(0, 5); // Max 5 topics
}

/**
 * Call Intelligence Service to classify RSS items.
 * Enhanced with retry logic and comprehensive error handling.
 */
async function classifyItemsWithIS(
  items: NormalizedRSSItem[],
  _config: RSSFeedConfig
): Promise<ClassifiedItem[]> {
  const isUrl = process.env.INTELLIGENCE_HUB_URL;
  const isApiKey = process.env.INTELLIGENCE_HUB_API_KEY;

  // Check if IS is configured
  if (!isUrl || !isApiKey) {
    logger.warn("IS not configured, using local classification fallback");
    return items.map((item) => ({
      ...item,
      topics: extractBasicTopics(item.title + " " + item.contentText),
      relevanceScore: 50,
      aiClassified: false,
    }));
  }

  try {
    // Call IS via Hub Protocol with retry
    const response = await withRetry(
      async () => {
        const res = await fetch(`${isUrl}/v1/tools/classify_feed_items`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isApiKey}`,
          },
          body: JSON.stringify({
            items: items.map((item) => ({
              title: item.title,
              description: item.contentText.slice(0, 500),
              url: item.url,
            })),
            options: {
              extractTopics: true,
              computeRelevance: true,
              mode: "detailed",
            },
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          throw new Error(`IS classification failed: ${response.status}`);
        }

        return res;
      },
      {
        ...FEED_RETRY_OPTIONS,
        maxRetries: 2,
        onRetry: (error: Error, attempt: number) => {
          logger.warn(
            { error: error.message, attempt, itemCount: items.length },
            "IS classification retry"
          );
        },
      }
    );

    const result = await response.json();

    // Validate response structure
    if (!result.classifiedItems || !Array.isArray(result.classifiedItems)) {
      logger.warn("IS returned invalid response structure, using fallback");
      throw new Error("Invalid IS response structure");
    }

    return items.map((item, index) => ({
      ...item,
      topics: result.classifiedItems[index]?.topics || [],
      relevanceScore: normalizeRelevanceScore(
        result.classifiedItems[index]?.relevanceScore ?? 0.5
      ),
      aiClassified: true,
    }));
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        itemCount: items.length,
        isUrl: isUrl?.replace(/\/v1.*$/, ""), // Log only base URL for privacy
      },
      "IS classification failed after retries, using fallback"
    );

    // Fallback: return items with basic classification
    return items.map((item) => ({
      ...item,
      topics: extractBasicTopics(item.title + " " + item.contentText),
      relevanceScore: 50,
      aiClassified: false,
    }));
  }
}

/**
 * Call Intelligence Service to classify RSS items.
 * Returns stub results if IS not ready.
 */
async function classifyItems(
  items: NormalizedRSSItem[],
  config: RSSFeedConfig,
  userId: string,
  _workspaceId?: string
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>();

  try {
    const classifiedItems = await classifyItemsWithIS(items, config);

    for (const item of classifiedItems) {
      results.set(item.id, {
        relevanceScore: item.relevanceScore,
        shouldInclude: item.relevanceScore >= (config.minRelevanceScore || 0),
        categories: item.topics.length > 0 ? item.topics : item.categories,
        summary:
          item.contentText.slice(0, 200) +
          (item.contentText.length > 200 ? "..." : ""),
      });
    }
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        userId,
        itemCount: items.length,
      },
      "Classification completely failed, using emergency fallback"
    );

    // Emergency fallback: include all items with neutral scores
    for (const item of items) {
      results.set(item.id, {
        relevanceScore: 50,
        shouldInclude: true,
        categories: item.categories,
      });
    }
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
 * Enhanced with partial success handling.
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
): Promise<{ posted: number; messageIds: string[]; errors: string[] }> {
  const messageIds: string[] = [];
  const errors: string[] = [];

  if (postMode === "batch" && items.length > 1) {
    // Post as single digest
    try {
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
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { error: errorMsg, channelId, itemCount: items.length },
        "Failed to post RSS batch"
      );
      errors.push(`Batch post failed: ${errorMsg}`);
    }
  } else {
    // Post individually with partial success handling
    for (const { item, classification } of items) {
      try {
        const content = formatItemContent(item, classification);
        const messageId = randomUUID();
        const hash = createHash("sha256")
          .update(`${messageId}${content}`)
          .digest("hex");

        const metadata = {
          feedItem: true as const,
          feedType: "rss" as const,
          source: {
            platform: item.source.name,
            url: item.url,
            author: item.author,
            publishedAt: item.publishedAt.toISOString(),
          },
          sourceUrl: item.url,
          sourceItemId: item.id,
          publishedAt: item.publishedAt.toISOString(),
          author: item.author,
          categories: classification.categories,
          topics: classification.categories,
          relevanceScore: classification.relevanceScore / 100, // Normalize to 0-1
          aiClassified: true,
          crossFeeds: [],
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
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(
          {
            error: errorMsg,
            itemId: item.id,
            itemTitle: item.title,
            channelId,
          },
          "Failed to post individual RSS item"
        );
        errors.push(`Item "${item.title}" failed: ${errorMsg}`);
      }
    }

    if (messageIds.length > 0) {
      logger.info(
        {
          successCount: messageIds.length,
          failCount: errors.length,
          totalCount: items.length,
        },
        "Posted RSS items with partial success"
      );
    }
  }

  return {
    posted: messageIds.length,
    messageIds,
    errors,
  };
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleFeedRSSExecute(job: {
  data: FeedExecutionPayload;
}): Promise<ExecutionResult> {
  const { channelId, userId, workspaceId, config, runId } = job.data;
  const errors: string[] = [];

  // Type guard: ensure this is an RSS feed config
  if (!isRSSFeedConfig(config)) {
    const error = `Expected RSS feed config, got ${config.feedType}`;
    logger.error({ channelId, feedType: config.feedType }, error);
    throw new Error(error);
  }

  logger.info(
    { channelId, runId, sourceCount: config.sources.length },
    "Starting RSS feed execution"
  );

  const startTime = Date.now();
  let itemCount = 0;
  let postedCount = 0;
  let fetchedCount = 0;

  try {
    // 1. Get seen URLs
    let seenUrls: Set<string>;
    try {
      seenUrls = await getSeenURLs(channelId, config.dedupWindowDays);
      logger.debug({ seenCount: seenUrls.size }, "Loaded seen URLs");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { error: errorMsg, channelId },
        "Failed to load seen URLs, using empty set"
      );
      errors.push(`Seen URL loading failed: ${errorMsg}`);
      seenUrls = new Set<string>();
    }

    // 2. Fetch RSS items with retry and comprehensive error handling
    let fetchResult: {
      items: NormalizedRSSItem[];
      errors: Array<{ source: string; error: string }>;
      sourceCount: number;
    };

    try {
      fetchResult = await withRetry(
        async () => {
          return await fetchRSSItems(config.sources, {
            useCpProxy: config.rsshubConfig?.useCpProxy ?? true,
            maxItems: config.maxItemsPerRun * 2, // Fetch more for filtering
          });
        },
        {
          ...FEED_RETRY_OPTIONS,
          maxRetries: 2,
          onRetry: (error: Error, attempt: number) => {
            logger.warn({ error: error.message, attempt }, "RSS fetch retry");
          },
        }
      );

      fetchedCount = fetchResult.items.length;

      if (fetchResult.errors.length > 0) {
        for (const sourceError of fetchResult.errors) {
          logger.warn(
            { source: sourceError.source, error: sourceError.error },
            "RSS source failed"
          );
          errors.push(`Source ${sourceError.source}: ${sourceError.error}`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { error: errorMsg, channelId, runId },
        "RSS fetch completely failed"
      );
      errors.push(`RSS fetch failed: ${errorMsg}`);

      // Update status and return partial failure
      await updateFeedStatus(
        channelId,
        {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "error",
          lastError: errorMsg,
        },
        config
      );

      return {
        success: false,
        itemsFetched: 0,
        itemsNew: 0,
        itemsPosted: 0,
        errors,
        partialSuccess: false,
      };
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

      return {
        success: true,
        itemsFetched: fetchedCount,
        itemsNew: 0,
        itemsPosted: 0,
        errors,
        partialSuccess: errors.length > 0,
      };
    }

    // 4. Classify items
    let classifications: Map<string, ClassificationResult>;
    try {
      classifications = await classifyItems(
        newItems,
        config,
        userId,
        workspaceId
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { error: errorMsg, channelId, itemCount: newItems.length },
        "Classification failed, using emergency fallback"
      );
      errors.push(`Classification failed: ${errorMsg}`);

      // Emergency fallback: include all with neutral scores
      classifications = new Map();
      for (const item of newItems) {
        classifications.set(item.id, {
          relevanceScore: 50,
          shouldInclude: true,
          categories: item.categories,
        });
      }
    }

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

      return {
        success: true,
        itemsFetched: fetchedCount,
        itemsNew: newItems.length,
        itemsPosted: 0,
        errors,
        partialSuccess: errors.length > 0,
      };
    }

    // 6. Post messages with partial success handling
    const postResult = await postRSSItems(
      channelId,
      userId,
      filteredItems,
      config.postMode,
      runId
    );
    postedCount = postResult.posted;

    if (postResult.errors.length > 0) {
      errors.push(...postResult.errors);
    }

    // 7. Emit side effects (non-fatal)
    try {
      await emitSideEffects({
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
          hasErrors: errors.length > 0,
        },
      });
    } catch (error) {
      logger.warn(
        { error, feedId: channelId },
        "Side effects failed (non-fatal)"
      );
    }

    // 8. Emit event (non-fatal)
    try {
      await eventRepository.append({
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
          errors: errors.length > 0 ? errors : undefined,
          partialSuccess: errors.length > 0 && postedCount > 0,
        },
      });
    } catch (error) {
      logger.warn(
        { error, feedId: channelId },
        "Event append failed (non-fatal)"
      );
    }

    // 9. Update feed status
    const hasErrors = errors.length > 0;
    const partialSuccess = hasErrors && postedCount > 0;

    await updateFeedStatus(
      channelId,
      {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: partialSuccess ? "partial" : "success",
        lastRunItemCount: postedCount,
        lastError: hasErrors ? errors.join("; ") : undefined,
      },
      config
    );

    logger.info(
      {
        runId,
        durationMs: Date.now() - startTime,
        posted: postedCount,
        errors: errors.length,
        partialSuccess,
      },
      "RSS feed execution complete"
    );

    return {
      success: !hasErrors || postedCount > 0,
      itemsFetched: fetchedCount,
      itemsNew: newItems.length,
      itemsPosted: postedCount,
      errors,
      partialSuccess,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        err,
        channelId,
        runId,
        stack: err instanceof Error ? err.stack : undefined,
      },
      "RSS feed execution failed catastrophically"
    );
    errors.push(`Catastrophic failure: ${error}`);

    // Update status with error
    try {
      await updateFeedStatus(
        channelId,
        {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "error",
          lastError: error,
        },
        config
      );
    } catch (statusError) {
      logger.error({ statusError }, "Failed to update feed status after error");
    }

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
    lastRunStatus: "success" | "error" | "running" | "partial";
    lastRunItemCount?: number;
    lastError?: string;
  },
  config: RSSFeedConfig
): Promise<void> {
  try {
    const channel = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
      columns: { metadata: true },
    });

    if (!channel) {
      logger.warn({ channelId }, "Channel not found for status update");
      return;
    }

    const metadata = (channel.metadata as Record<string, unknown>) ?? {};
    const currentStatus =
      (metadata.feedStatus as Record<string, unknown>) ?? {};

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

    logger.debug(
      { channelId, status: status.lastRunStatus },
      "Feed status updated"
    );
  } catch (error) {
    logger.error({ error, channelId }, "Failed to update feed status");
    // Non-fatal: don't throw
  }
}
