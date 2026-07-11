/**
 * Entity Extract Worker
 *
 * Consumes items from FEED_SOURCE_ITEMS_QUEUE (published by feed-source-executor
 * after fetching via any provider — CPRelay/web-scraper, RSS, etc.).
 *
 * Pipeline:
 *   1. Deduplicate by URL (track seen URLs in subscription.params.seenUrls).
 *   2. Call IS `/v1/tools/classify_feed_items` for relevance scoring + topic extraction.
 *   3. Filter items below the relevance threshold from the feed config.
 *   4. Create first-class Synap entities (bookmark) via EntityRepository.
 *   5. Post highlights to the user's proactive feed channel.
 *   6. Emit side-effects and events.
 *
 * Queue name: "feed-source-items"
 * Registered by: feed-source-executor (send, fire-and-forget)
 */

import { randomUUID } from "crypto";
import {
  db,
  eq,
  and,
  getDb,
  materializeEntity,
  EventRepository,
  ChannelRepository,
} from "@synap/database";
import { OperationalEventTypes } from "@synap/events";
import { sql as drizzleSql } from "drizzle-orm";
import { sql as dbSql } from "@synap/database";
import { computeMessageHash } from "@synap/database";
import {
  messages,
  sourceSubscriptions,
  sourceConfigs,
} from "@synap/database/schema";
import { createLogger, ServiceUnavailableError } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { withRetry, FEED_RETRY_OPTIONS } from "@synap/shared-utils";
import { getDefaultActiveService } from "@synap/intelligence-client";
import type { SourceItem } from "@synap/feed-service";
import { MessageRole, MessageAuthorType } from "@synap/database/schema";
import type { FeedMessageMetadata } from "@synap-core/types/feeds";
import { z } from "zod";

const FeedMessageMetadataSchema = z.object({
  feedItem: z.literal(true),
  feedType: z.enum(["rss", "proactive", "automation"]),
  source: z.object({ platform: z.string(), url: z.string() }),
  topics: z.array(z.string()),
  categories: z.array(z.string()),
  relevanceScore: z.number().min(0).max(1),
  aiClassified: z.boolean(),
  crossFeeds: z.array(z.any()).default([]),
  batched: z.boolean().optional(),
  batchId: z.string().uuid().optional(),
});

const logger = createLogger({ module: "entity-extract" });

// ── Types ────────────────────────────────────────────────────────────────────

/** Payload published by feed-source-executor. */
export interface EntityExtractJobPayload {
  subscriptionId: string;
  feedId: string;
  userId: string;
  workspaceId?: string;
  runId?: string;
  items: SourceItem[];
}

interface ClassificationResult {
  id: string;
  title: string;
  url: string;
  source?: string;
  topics: { name: string; confidence: number; source: string }[];
  relevanceScore: number;
  relevanceExplanation?: string;
  summary?: string;
}

// ── Deduplication ────────────────────────────────────────────────────────────

/**
 * Track seen URLs in the subscription's `params.seenUrls` JSONB field.
 * Returns items that haven't been seen, and stores their URLs.
 */
async function deduplicateItems(
  subscriptionId: string,
  items: SourceItem[]
): Promise<SourceItem[]> {
  const subscription = await db.query.sourceSubscriptions.findFirst({
    where: eq(sourceSubscriptions.id, subscriptionId),
  });
  if (!subscription) return [];

  const seenUrls = new Set<string>(
    ((subscription.params as Record<string, unknown>)?.seenUrls as string[]) ??
      []
  );

  const newItems: SourceItem[] = [];
  for (const item of items) {
    const url = item.url.trim().toLowerCase();
    if (seenUrls.has(url)) {
      logger.debug({ url: url.slice(0, 80) }, "Skipping duplicate URL");
      continue;
    }
    newItems.push(item);
    seenUrls.add(url);
  }

  // Persist seen URLs if we added new ones.
  // Use jsonb_set to update only the seenUrls key — avoids racing with
  // setupFeed's concurrent update to derivedQueries.
  if (newItems.length > 0) {
    const capped = Array.from(seenUrls).slice(-5000);
    try {
      await db
        .update(sourceSubscriptions)
        .set({
          params: drizzleSql`jsonb_set(COALESCE(params, '{}'), '{seenUrls}', ${JSON.stringify(capped)}::jsonb, true)`,
          updatedAt: new Date(),
        })
        .where(eq(sourceSubscriptions.id, subscriptionId));
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "Failed to persist seen URLs (non-fatal)"
      );
    }
  }

  logger.info(
    {
      total: items.length,
      new: newItems.length,
      deduped: items.length - newItems.length,
    },
    "Deduplication complete"
  );

  return newItems;
}

// ── IS Classification ────────────────────────────────────────────────────────

/**
 * Classify items with the Intelligence Service.
 * Returns a map from lowercased URL → ClassificationResult.
 */
async function classifyWithIS(
  items: Array<{
    url: string;
    title: string;
    excerpt?: string;
    bodyText?: string;
  }>,
  _userId: string,
  _workspaceId: string | undefined,
  feedType: string
): Promise<Record<string, ClassificationResult>> {
  // Canonical IS credential resolution (decrypted DB key), not stale env — the
  // env key rotates dead on a CP→pod re-provision (is-credential-env-vs-db-drift).
  const { endpoint: isUrl, apiKey: isApiKey } = await getDefaultActiveService();

  if (!isUrl || !isApiKey) {
    logger.warn("IS not configured, skipping classification");
    return {};
  }

  // Batch items in groups of 20 (IS API limit)
  const batches: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += 20) {
    batches.push(items.slice(i, i + 20));
  }

  const results: Record<string, ClassificationResult> = {};

  const personaMap: Record<string, string> = {
    "lead-tracking": "sales",
    "competitor-monitoring": "researcher",
    ecosystem: "product-manager",
    "project-mentions": "project-manager",
    tech: "cto",
    business: "founder",
    crypto: "founder",
    social: "marketing",
    news: "default",
  };

  const interestKeywords: Record<string, string[]> = {
    "lead-tracking": [
      "startup",
      "funding",
      "raise",
      "series a",
      "series b",
      "launch",
      "hiring",
      "acq",
    ],
    "competitor-monitoring": [
      "competitor",
      "alternative",
      "vs",
      "comparison",
      "pricing",
      "feature",
    ],
    ecosystem: [
      "open source",
      "api",
      "sdk",
      "platform",
      "infrastructure",
      "developer",
    ],
    "project-mentions": [
      "project",
      "repository",
      "github",
      "release",
      "update",
    ],
    tech: [
      "technology",
      "software",
      "engineering",
      "architecture",
      "devops",
      "ai",
      "ml",
    ],
    business: [
      "business",
      "market",
      "industry",
      "economy",
      "finance",
      "startup",
    ],
    crypto: ["crypto", "blockchain", "web3", "defi", "nft", "token", "chain"],
    social: ["social", "media", "community", "influencer", "viral"],
    news: ["news", "world", "current"],
  };

  for (const batch of batches) {
    const feedItems = batch.map((item, idx) => ({
      id: `item-${idx}`,
      title: item.title,
      description: item.excerpt,
      content: item.bodyText ?? item.excerpt ?? "",
      url: item.url,
      source: undefined,
      publishedAt: undefined,
    }));

    try {
      const response = await withRetry(
        async () => {
          const res = await fetch(
            `${isUrl.replace(/\/$/, "")}/v1/tools/classify_feed_items`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Internal-Key": isApiKey,
              },
              body: JSON.stringify({
                items: feedItems,
                options: {
                  mode: "detailed" as const,
                  extractTopics: true,
                  computeRelevance: true,
                  generateSummary: true,
                  explainRelevance: true,
                  relevanceThreshold: 0.1,
                },
                userContext: {
                  interests: interestKeywords[feedType] ?? [],
                  persona: personaMap[feedType] ?? "default",
                },
              }),
              signal: AbortSignal.timeout(30_000),
            }
          );

          if (!response.ok) {
            throw new ServiceUnavailableError(
              `IS classify returned ${response.status}`
            );
          }

          return res;
        },
        { ...FEED_RETRY_OPTIONS, maxRetries: 2 }
      );

      const json = (await response.json()) as { items: ClassificationResult[] };
      for (const r of json.items ?? []) {
        results[r.url.trim().toLowerCase()] = r;
      }
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : "unknown" },
        "IS classify batch failed (items pass through unclassified)"
      );
    }
  }

  return results;
}

// ── Feed Config Resolution ───────────────────────────────────────────────────

interface FeedConfig {
  feedType: string;
  minRelevanceScore: number; // 0-1
  enrichmentEnabled: boolean;
  agentConfig: Record<string, unknown>;
  feedArchetype?: string; // archetype slug from source_config.metadata (e.g. "leads")
}

async function resolveFeedConfig(
  subscriptionId: string,
  userId: string
): Promise<FeedConfig & { channelId?: string }> {
  try {
    const subscription = await db.query.sourceSubscriptions.findFirst({
      where: and(
        eq(sourceSubscriptions.id, subscriptionId),
        eq(sourceSubscriptions.userId, userId)
      ),
    });

    if (!subscription) throw new Error("Subscription not found");

    const sourceConfig = await db.query.sourceConfigs.findFirst({
      where: eq(sourceConfigs.id, subscription.sourceConfigId),
    });

    const config = (sourceConfig?.config as Record<string, unknown>) ?? {};
    const params = (subscription.params as Record<string, unknown>) ?? {};
    const providerType = sourceConfig?.providerType as string;

    let agentConfig: Record<string, unknown> = {};

    const sourceAgentConfig =
      (config.agentConfig as Record<string, unknown>) ?? {};
    const paramAgentConfig =
      (params.agentConfig as Record<string, unknown>) ?? {};
    agentConfig = { ...sourceAgentConfig, ...paramAgentConfig };

    const feedTypeFromParams = params.feedType as string | undefined;
    const feedTypeFromConfig = config.feedType as string | undefined;
    const providerTypeAsFeed =
      providerType === "rss-direct" ? "rss" : providerType;
    const feedType =
      feedTypeFromParams ??
      feedTypeFromConfig ??
      (agentConfig.feedType as string) ??
      providerTypeAsFeed ??
      "rss";

    let minRelevanceScore: number;
    const relevanceFromAgent = agentConfig.minRelevanceScore as
      | number
      | undefined;
    const relevanceFromConfig = config.minRelevanceScore as number | undefined;

    if (typeof relevanceFromAgent === "number") {
      minRelevanceScore =
        relevanceFromAgent > 1 ? relevanceFromAgent / 100 : relevanceFromAgent;
    } else if (typeof relevanceFromConfig === "number") {
      minRelevanceScore =
        relevanceFromConfig > 1
          ? relevanceFromConfig / 100
          : relevanceFromConfig;
    } else {
      minRelevanceScore = 0;
    }

    const enrichmentFromAgent = agentConfig.enrichmentEnabled;
    if (typeof enrichmentFromAgent === "boolean") {
      // keep as-is
    } else if (typeof (config.enrichmentEnabled as boolean) === "boolean") {
      agentConfig.enrichmentEnabled = config.enrichmentEnabled as boolean;
    }

    const feedArchetype =
      ((sourceConfig?.metadata as Record<string, unknown>)?.archetype as
        | string
        | undefined) ?? undefined;

    return {
      feedType,
      minRelevanceScore,
      enrichmentEnabled:
        (agentConfig.enrichmentEnabled ?? config.enrichmentEnabled ?? true) ===
        true,
      agentConfig,
      feedArchetype,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : "unknown", subscriptionId },
      "Failed to resolve feed config, using defaults"
    );
  }

  return {
    feedType: "rss",
    minRelevanceScore: 0,
    enrichmentEnabled: true,
    agentConfig: {},
  };
}

// ── Entity Creation ──────────────────────────────────────────────────────────

async function createEntityFromItem(
  item: SourceItem,
  feedType: string,
  userId: string,
  workspaceId: string | undefined,
  classification: ClassificationResult | undefined,
  sourceConfigId: string,
  database: Awaited<ReturnType<typeof getDb>>,
  eventRepo: EventRepository
): Promise<string> {
  const props: Record<string, unknown> = {
    url: item.url,
    source: sourceConfigId,
    feedType,
    topics: classification?.topics?.map((t) => t.name) ?? [],
    relevanceScore: classification?.relevanceScore ?? 1.0,
  };

  if (item.excerpt) props.excerpt = item.excerpt;
  if (item.imageUrl) props.imageUrl = item.imageUrl;
  if (item.author) props.author = item.author;
  if (item.publishedAt) props.publishedAt = item.publishedAt.toISOString();
  if (classification?.summary) props.summary = classification.summary;

  // Extra body text from raw (if web-scraper upstream)
  const rawBody = (item.raw as Record<string, unknown>)?.bodyText;
  if (typeof rawBody === "string") props.bodyText = rawBody;

  // Provenance = system: an automated feed-ingestion pipeline created this
  // bookmark (no human clicked, no agent authored it). Funnel through the
  // governed materializer so provenance is stamped explicitly rather than
  // defaulting to "human".
  const { entity } = await materializeEntity(
    {
      profileSlug: "bookmark",
      title: item.title.slice(0, 500),
      preview: item.excerpt?.slice(0, 1000),
      properties: props,
      userId,
      workspaceId: workspaceId ?? null,
    },
    {
      db: database,
      eventRepo,
      provenance: { createdByKind: "system" },
    }
  );

  return entity.id;
}

// ── Proactive Feed Posting ───────────────────────────────────────────────────

async function postToProactiveFeed(
  userId: string,
  _workspaceId: string | undefined,
  highlightedItems: Array<{
    title: string;
    url: string;
    summary?: string;
    topics: string[];
  }>,
  runId: string
): Promise<string | undefined> {
  if (highlightedItems.length === 0) return undefined;

  // Resolve the user's feed channel through the canonical race-safe door — active
  // + oldest-wins, so a post-0182 'merged' duplicate is never targeted (a raw
  // findFirst without a status filter could resolve a dead feed → posts vanish).
  const feedChannel = await new ChannelRepository(db).ensureProactiveFeedChannel(
    userId
  );

  // Build markdown summary
  const lines = [`## New Items Discovered (${highlightedItems.length})`];
  lines.push("");
  for (const item of highlightedItems.slice(0, 10)) {
    lines.push(`- **[${item.title}](${item.url})**`);
    if (item.summary) {
      lines.push(`  _${item.summary.slice(0, 200)}_`);
    }
    if (item.topics.length > 0) {
      lines.push(`  Tags: ${item.topics.join(", ")}`);
    }
    lines.push("");
  }

  const content = lines.join("\n");
  const hash = computeMessageHash(runId, content);

  let metadata: FeedMessageMetadata;
  try {
    metadata = FeedMessageMetadataSchema.parse({
      feedItem: true,
      feedType: "proactive",
      source: { platform: "entity-extract", url: "" },
      topics: highlightedItems.flatMap((i) => i.topics),
      categories: [],
      relevanceScore: 0.7,
      aiClassified: true,
      crossFeeds: [],
      batched: highlightedItems.length > 1,
    });
  } catch {
    metadata = {
      feedItem: true,
      feedType: "proactive",
      source: { platform: "entity-extract", url: "" },
      topics: [],
      categories: [],
      relevanceScore: 0.5,
      aiClassified: true,
      crossFeeds: [],
      batched: highlightedItems.length > 1,
    };
  }

  await db.insert(messages).values({
    channelId: feedChannel.id,
    userId,
    role: MessageRole.SYSTEM,
    authorType: MessageAuthorType.BOT,
    content,
    hash,
    previousHash: "",
    metadata: metadata as unknown as null,
  });

  logger.info(
    { channelId: feedChannel.id, itemCount: highlightedItems.length },
    "Posted proactive feed digest"
  );

  return feedChannel.id;
}

// ── Main Handler ─────────────────────────────────────────────────────────────

type ExtractResult = {
  ok: boolean;
  itemsReceived: number;
  itemsDeduped: number;
  itemsClassified: number;
  itemsCreated: number;
  itemsFiltered: number;
  error?: string;
};

export async function handleEntityExtract(job: {
  data: EntityExtractJobPayload;
}): Promise<ExtractResult> {
  const { subscriptionId, feedId, userId, workspaceId, runId, items } =
    job.data;

  const startTime = Date.now();
  const jobRunId = runId ?? randomUUID();
  const result: ExtractResult = {
    ok: true,
    itemsReceived: items.length,
    itemsDeduped: 0,
    itemsClassified: 0,
    itemsCreated: 0,
    itemsFiltered: 0,
  };

  try {
    // 0. Resolve db + event repo (entity creation funnels through materializeEntity)
    const database = await getDb();
    const eventRepo = new EventRepository(dbSql);

    // 1. Resolve subscription and feed config
    const subscription = await db.query.sourceSubscriptions.findFirst({
      where: eq(sourceSubscriptions.id, subscriptionId),
    });
    if (!subscription) {
      return { ...result, ok: false, error: "subscription not found" };
    }

    const feedConfig = await resolveFeedConfig(subscriptionId, userId);

    // 2. Resolve source config for provenance
    const configId = subscription.sourceConfigId;

    // 3. Deduplicate
    const deduped = await deduplicateItems(subscriptionId, items);
    result.itemsDeduped = items.length - deduped.length;

    if (deduped.length === 0) {
      logger.info(
        { subscriptionId, runId: jobRunId },
        "All items deduplicated — nothing to process"
      );
      return result;
    }

    // 4. Classify with IS (if enrichment enabled)
    let classificationMap: Record<string, ClassificationResult> = {};

    if (feedConfig.enrichmentEnabled) {
      const classifiedItems = deduped.map((item) => ({
        url: item.url.trim().toLowerCase(),
        title: item.title,
        excerpt: item.excerpt,
        bodyText: (item.raw as Record<string, unknown>)?.bodyText as
          | string
          | undefined,
      }));

      classificationMap = await classifyWithIS(
        classifiedItems,
        userId,
        workspaceId,
        feedConfig.feedType
      );
      result.itemsClassified = Object.keys(classificationMap).length;
    }

    // 5. Filter by relevance threshold
    const threshold = feedConfig.minRelevanceScore;
    const filteredItems: Array<{
      item: SourceItem;
      classification?: ClassificationResult;
    }> = [];

    for (const item of deduped) {
      const cls = classificationMap[item.url.trim().toLowerCase()];
      if (!cls) {
        if (threshold <= 0) {
          filteredItems.push({ item });
        }
        continue;
      }

      if (cls.relevanceScore >= threshold) {
        filteredItems.push({ item, classification: cls });
      } else {
        result.itemsFiltered++;
      }
    }

    // 6. Create entities
    const highlighted: Array<{
      title: string;
      url: string;
      summary?: string;
      topics: string[];
    }> = [];

    for (const { item, classification } of filteredItems) {
      try {
        const entityId = await createEntityFromItem(
          item,
          feedConfig.feedType,
          userId,
          workspaceId,
          classification,
          configId,
          database,
          eventRepo
        );
        result.itemsCreated++;

        if (classification) {
          highlighted.push({
            title: item.title,
            url: item.url,
            summary: classification.summary,
            topics: classification.topics.map((t) => t.name),
          });
        }

        // Emit per-entity automation trigger event (non-fatal)
        try {
          await eventRepo.append({
            id: randomUUID(),
            version: "v1",
            type: OperationalEventTypes.FEED_NEW_ITEM.type,
            subjectType: "feed",
            subjectId: entityId,
            userId,
            source: "system",
            timestamp: new Date(),
            data: {
              entityId,
              feedId,
              subscriptionId,
              feedArchetype: feedConfig.feedArchetype,
              feedType: feedConfig.feedType,
              relevanceScore: classification?.relevanceScore ?? 1.0,
              title: item.title.slice(0, 500),
              url: item.url,
              topics: classification?.topics?.map((t) => t.name) ?? [],
            },
          });
        } catch (evtErr) {
          logger.debug(
            { err: evtErr instanceof Error ? evtErr.message : "unknown" },
            "feed.new_item event append failed (non-fatal)"
          );
        }

        logger.debug(
          { entityId, title: item.title.slice(0, 60) },
          "Entity created from feed item"
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { err: errorMsg, url: item.url.slice(0, 80) },
          "Failed to create entity from item (non-fatal — continue)"
        );
      }
    }

    // 7. Post to proactive feed (highlights only)
    try {
      await postToProactiveFeed(userId, undefined, highlighted, jobRunId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "Proactive feed post failed (non-fatal)"
      );
    }

    // 8. Emit side effects
    try {
      await emitSideEffects({
        subjectType: "feed",
        action: "entity_extract",
        subjectId: jobRunId,
        userId,
        workspaceId,
        data: {
          subscriptionId,
          feedId,
          itemsReceived: items.length,
          itemsDeduped: result.itemsDeduped,
          itemsClassified: result.itemsClassified,
          itemsCreated: result.itemsCreated,
          itemsFiltered: result.itemsFiltered,
          durationMs: Date.now() - startTime,
        },
      });
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : "unknown" },
        "Side effects emission failed (non-fatal)"
      );
    }

    // 9. Emit event
    try {
      await eventRepo.append({
        id: randomUUID(),
        version: "v1",
        type: "feed.entity_extract.completed",
        subjectType: "feed",
        subjectId: jobRunId,
        userId,
        source: "system",
        timestamp: new Date(),
        data: {
          subscriptionId,
          feedId,
          itemsReceived: items.length,
          itemsDeduped: result.itemsDeduped,
          itemsClassified: result.itemsClassified,
          itemsCreated: result.itemsCreated,
          itemsFiltered: result.itemsFiltered,
          durationMs: Date.now() - startTime,
        },
      });
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : "unknown" },
        "Event append failed (non-fatal)"
      );
    }

    logger.info(
      {
        subscriptionId,
        runId: jobRunId,
        ...result,
        durationMs: Date.now() - startTime,
      },
      "Entity extract complete"
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: errorMsg, subscriptionId, feedId },
      "Entity extract failed catastrophically"
    );
    result.ok = false;
    result.error = errorMsg;
  }

  return result;
}
