/**
 * Hub Protocol — Signals Router
 *
 * Signal feed operations for RSS/feed content:
 * - Fetch: Get raw feed data
 * - Classify: AI classification of signal items
 * - Capture: Create signal_item entities from signals
 * - Feed: Personalized signal feed
 * - Context: User personalization context
 * - Subscriptions: Manage signal subscriptions
 * - Batch: Execute multiple operations with dependencies
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { checkHubRateLimit } from "../../utils/hub-protocol-rate-limit.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { assertMayActAs } from "./guard.js";
import { config } from "@synap-core/core";
import { db, eq, and, desc, isNull, sqlTemplate as sql } from "@synap/database";
import {
  signalSubscriptions,
  signalClassifications,
  signalFetchHistory,
  signalAutoLinks,
  entities,
} from "@synap/database/schema";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";
import { DeliveryService } from "../../services/DeliveryService.js";

const SIGNAL_PLATFORMS = [
  "twitter",
  "reddit",
  "hackernews",
  "youtube",
  "rss",
  "mastodon",
  "bluesky",
] as const;
type SignalPlatform = (typeof SIGNAL_PLATFORMS)[number];

export interface RssHubItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
  author?: string;
  guid?: string;
}

function formatErrorResponse(
  error: string,
  errorCode: string,
  details?: unknown
) {
  return {
    success: false as const,
    error,
    errorCode,
    ...(details !== undefined ? { details } : {}),
  };
}

/**
 * Format signal data for feed display
 */
function formatSignalForFeed(signalData: {
  title?: string;
  description?: string;
  aiSummary?: string;
  url?: string;
  sourcePlatform?: string;
  authorDisplayName?: string;
  authorUsername?: string;
}): string {
  const parts: string[] = [];

  // Use AI summary if available, otherwise use description
  const content = signalData.aiSummary || signalData.description || "";
  if (content) {
    parts.push(content);
  }

  // Add source attribution
  const sourceParts: string[] = [];
  if (signalData.sourcePlatform) {
    sourceParts.push(`via ${signalData.sourcePlatform}`);
  }
  if (signalData.authorDisplayName || signalData.authorUsername) {
    const author = signalData.authorDisplayName || signalData.authorUsername;
    sourceParts.push(`by ${author}`);
  }

  if (sourceParts.length > 0) {
    parts.push(`\n— ${sourceParts.join(" ")}`);
  }

  return parts.join("\n");
}

export const signalsRouter = router({
  /**
   * POST /signals/fetch - Fetch RSSHub data via CP proxy
   * Requires: hub-protocol.read scope
   */
  fetch: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        sourceRoute: z.string().min(1),
        sourcePlatform: z.enum(SIGNAL_PLATFORMS),
        options: z
          .object({
            limit: z.number().int().min(1).max(100).default(50),
            since: z.string().datetime().optional(),
            forceRefresh: z.boolean().default(false),
            timeoutMs: z.number().int().min(1000).max(60000).default(30000),
          })
          .optional(),
        context: z
          .object({
            workspaceId: z.string().uuid(),
            userId: z.string(),
            currentTopics: z.array(z.string()).optional(),
          })
          .optional(),
      })
    )
    .mutation(
      async ({
        input,
        ctx,
      }): Promise<{
        success: boolean;
        items: RssHubItem[];
        metadata: {
          sourceRoute: string;
          sourcePlatform: string;
          fetchedAt: string;
          cacheHit: boolean;
          itemCount: number;
          durationMs: number;
          rateLimit?: { limit: number; remaining: number; resetAt: string };
        };
        error?: string;
      }> => {
        const startTime = Date.now();
        checkHubRateLimit(ctx.apiKeyId, "signals.fetch");

        const cpUrl = config.server.controlPlaneUrl;
        if (!cpUrl) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Control plane URL not configured",
          });
        }

        const limit = input.options?.limit ?? 50;
        const forceRefresh = input.options?.forceRefresh ?? false;
        const timeoutMs = input.options?.timeoutMs ?? 30000;

        let proxyUrl = `${cpUrl}/api/sources/relay${input.sourceRoute}`;
        const params = new URLSearchParams();
        if (limit !== 50) params.set("limit", String(limit));
        if (forceRefresh) params.set("forceRefresh", "1");
        if (input.options?.since) params.set("since", input.options.since);
        const queryString = params.toString();
        if (queryString) proxyUrl += `?${queryString}`;

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          const response = await fetch(proxyUrl, {
            method: "GET",
            headers: {
              "User-Agent": "Synap-Signal-Feed/1.0",
              Accept:
                "application/rss+xml, application/xml, text/xml, application/atom+xml, */*",
            },
            signal: controller.signal,
          });

          clearTimeout(timer);

          if (!response.ok) {
            return {
              ...formatErrorResponse(
                `CP proxy returned ${response.status}`,
                "CP_PROXY_ERROR",
                { status: response.status, statusText: response.statusText }
              ),
              items: [],
              metadata: {
                sourceRoute: input.sourceRoute,
                sourcePlatform: input.sourcePlatform,
                fetchedAt: new Date().toISOString(),
                cacheHit: false,
                itemCount: 0,
                durationMs: Date.now() - startTime,
              },
            };
          }

          const contentType = response.headers.get("content-type") || "";
          let items: RssHubItem[] = [];

          if (
            contentType.includes("xml") ||
            contentType.includes("rss") ||
            contentType.includes("atom")
          ) {
            const xmlText = await response.text();
            items = parseRssXml(xmlText);
          } else {
            items = (await response.json()) as RssHubItem[];
          }

          const workspaceId = input.context?.workspaceId;
          if (workspaceId && ctx.userId) {
            await db.insert(signalFetchHistory).values({
              id: randomUUID(),
              userId: ctx.userId,
              workspaceId,
              sourceRoute: input.sourceRoute,
              sourcePlatform: input.sourcePlatform,
              fetchType: "cp-relay",
              itemCount: items.length,
              cacheHit: !forceRefresh,
              durationMs: Date.now() - startTime,
              fetchedAt: new Date(),
            });
          }

          return {
            success: true,
            items: items.slice(0, limit),
            metadata: {
              sourceRoute: input.sourceRoute,
              sourcePlatform: input.sourcePlatform,
              fetchedAt: new Date().toISOString(),
              cacheHit: !forceRefresh,
              itemCount: items.length,
              durationMs: Date.now() - startTime,
            },
          };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return {
              ...formatErrorResponse(
                "CP proxy request timed out",
                "CP_PROXY_TIMEOUT"
              ),
              items: [],
              metadata: {
                sourceRoute: input.sourceRoute,
                sourcePlatform: input.sourcePlatform,
                fetchedAt: new Date().toISOString(),
                cacheHit: false,
                itemCount: 0,
                durationMs: Date.now() - startTime,
              },
            };
          }
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to fetch from RSSHub: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    ),

  /**
   * POST /signals/classify - AI classification of signal items
   * Requires: hub-protocol.read scope
   */
  classify: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        items: z.array(
          z.object({
            title: z.string().optional(),
            link: z.string().optional(),
            description: z.string().optional(),
            pubDate: z.string().optional(),
            author: z.string().optional(),
          })
        ),
        classification: z
          .object({
            mode: z
              .enum(["quick", "detailed", "comprehensive"])
              .default("quick"),
            extractTopics: z.boolean().default(true),
            computeRelevance: z.boolean().default(true),
            extractEntities: z.boolean().default(true),
            generateSummary: z.boolean().default(false),
          })
          .optional(),
        context: z.object({
          workspaceId: z.string().uuid(),
          userId: z.string(),
          userPreferences: z
            .object({
              subscriptions: z
                .array(z.object({ topic: z.string(), confidence: z.number() }))
                .optional(),
              classifications: z
                .array(
                  z.object({
                    topic: z.string(),
                    confidence: z.number(),
                    lastUpdated: z.string(),
                  })
                )
                .optional(),
            })
            .optional(),
          currentFocus: z
            .object({
              activeTasks: z.array(z.string()).optional(),
              recentSearches: z.array(z.string()).optional(),
              discussedPeople: z.array(z.string()).optional(),
            })
            .optional(),
        }),
      })
    )
    .mutation(
      async ({
        input,
        ctx,
      }): Promise<{
        success: boolean;
        items: Array<{
          id: string;
          originalItem: RssHubItem;
          topics: Array<{ name: string; confidence: number; source: string }>;
          relevanceScore: number;
          entities?: Array<{
            type: string;
            name: string;
            confidence: number;
            context?: string;
          }>;
          aiSummary?: string;
          classificationTimestamp: string;
          classificationModel: string;
        }>;
        metadata: {
          classificationMode: string;
          modelUsed: string;
          durationMs: number;
          tokensUsed?: number;
          summary?: {
            totalItems: number;
            topicsFound: string[];
            averageRelevance: number;
            entityExtractionStats: {
              people: number;
              companies: number;
              products: number;
            };
          };
        };
        error?: string;
      }> => {
        const startTime = Date.now();
        checkHubRateLimit(ctx.apiKeyId, "signals.classify");

        const mode = input.classification?.mode ?? "quick";
        const classifyItems = input.items.map((item) => ({
          id: randomUUID(),
          originalItem: item,
          topics: extractTopicsFromItem(item, input.context.userPreferences),
          relevanceScore: computeRelevanceScore(
            item,
            input.context.userPreferences
          ),
          entities: input.classification?.extractEntities
            ? extractEntitiesFromItem(item)
            : undefined,
          aiSummary: input.classification?.generateSummary
            ? generateSummary(item)
            : undefined,
          classificationTimestamp: new Date().toISOString(),
          classificationModel: "deepseek-chat",
        }));

        const allTopics = classifyItems.flatMap((i) =>
          i.topics.map((t) => t.name)
        );
        const uniqueTopics = [...new Set(allTopics)];
        const avgRelevance =
          classifyItems.reduce((sum, i) => sum + i.relevanceScore, 0) /
          classifyItems.length;

        return {
          success: true,
          items: classifyItems,
          metadata: {
            classificationMode: mode,
            modelUsed: "deepseek-chat",
            durationMs: Date.now() - startTime,
            summary: {
              totalItems: classifyItems.length,
              topicsFound: uniqueTopics,
              averageRelevance: avgRelevance,
              entityExtractionStats: {
                people: classifyItems.reduce(
                  (sum, i) =>
                    sum +
                    (i.entities?.filter((e) => e.type === "person").length ??
                      0),
                  0
                ),
                companies: classifyItems.reduce(
                  (sum, i) =>
                    sum +
                    (i.entities?.filter((e) => e.type === "company").length ??
                      0),
                  0
                ),
                products: classifyItems.reduce(
                  (sum, i) =>
                    sum +
                    (i.entities?.filter((e) => e.type === "product").length ??
                      0),
                  0
                ),
              },
            },
          },
        };
      }
    ),

  /**
   * POST /signals/capture - Create signal_item entity from classified signal
   * Requires: hub-protocol.write scope
   */
  capture: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        signalData: z.object({
          sourcePlatform: z.enum(SIGNAL_PLATFORMS),
          sourceRoute: z.string(),
          url: z.string().url(),
          title: z.string(),
          description: z.string().optional(),
          publishedAt: z.string().datetime(),
          authorUsername: z.string().optional(),
          authorDisplayName: z.string().optional(),
          authorUrl: z.string().optional(),
          aiSummary: z.string().optional(),
          topics: z.array(z.string()),
          relevanceScore: z.number().min(0).max(1).optional(),
          rawData: z.record(z.string(), z.unknown()).optional(),
        }),
        capture: z.object({
          workspaceId: z.string().uuid(),
          userId: z.string(),
          captureMethod: z
            .enum(["manual", "automation", "ai_suggestion"])
            .default("manual"),
          captureReason: z.string().optional(),
          autoLinkEntities: z.boolean().default(true),
          linkStrengthThreshold: z.number().min(0).max(1).default(0.3),
          createNotification: z.boolean().default(true),
          notificationType: z.enum(["toast", "feed", "both"]).default("toast"),
        }),
      })
    )
    .mutation(
      async ({
        input,
        ctx,
      }): Promise<{
        success: boolean;
        entity?: {
          id: string;
          profileSlug: string;
          name: string;
          properties: Record<string, unknown>;
          createdAt: string;
          updatedAt: string;
        };
        autoLinking?: {
          linkedEntities: Array<{
            entityId: string;
            entityType: string;
            entityName: string;
            linkType: string;
            linkStrength: number;
          }>;
          totalLinked: number;
        };
        delivery?: {
          feedPosted: boolean;
          notificationCreated: boolean;
        };
        metadata: {
          captureTimestamp: string;
          captureMethod: string;
          processingDurationMs: number;
        };
        error?: string;
      }> => {
        const startTime = Date.now();
        checkHubRateLimit(ctx.apiKeyId, "signals.capture");

        const { workspaceId, userId } = input.capture;
        assertMayActAs(ctx, userId);

        const callerContext = await createHubProtocolCallerContext(
          userId,
          ctx.scopes || [],
          workspaceId
        );
        const caller = regularEntitiesRouter.createCaller(callerContext);

        try {
          const result = await caller.create({
            profileSlug: "signal_item",
            title: input.signalData.title,
            description: input.signalData.description,
            properties: {
              url: input.signalData.url,
              domain: new URL(input.signalData.url).hostname,
              sourcePlatform: input.signalData.sourcePlatform,
              sourceRoute: input.signalData.sourceRoute,
              authorUsername: input.signalData.authorUsername,
              authorDisplayName: input.signalData.authorDisplayName,
              authorUrl: input.signalData.authorUrl,
              publishedAt: input.signalData.publishedAt,
              aiSummary: input.signalData.aiSummary,
              topics: input.signalData.topics,
              relevanceScore: input.signalData.relevanceScore ?? 0.5,
              sentiment: undefined,
              rawData: input.signalData.rawData,
              capturedFromFeed: true,
              captureMethod: input.capture.captureMethod,
              captureCount: 1,
            },
            source: "intelligence",
          });

          if (!result.id) {
            return {
              ...formatErrorResponse(
                "Failed to create entity",
                "ENTITY_CREATION_FAILED"
              ),
              delivery: {
                feedPosted: false,
                notificationCreated: false,
              },
              metadata: {
                captureTimestamp: new Date().toISOString(),
                captureMethod: input.capture.captureMethod,
                processingDurationMs: Date.now() - startTime,
              },
            };
          }

          // Deliver signal to feed via DeliveryService
          let feedPosted = false;
          let notificationCreated = false;
          if (input.capture.createNotification) {
            try {
              const relevance = input.signalData.relevanceScore ?? 0.5;
              const formattedContent = formatSignalForFeed(input.signalData);

              const deliveryResult = await DeliveryService.deliver({
                userId: input.capture.userId,
                workspaceId: input.capture.workspaceId,
                content: {
                  title: input.signalData.title,
                  body: formattedContent,
                  sourceType: "ai_proactive",
                  metadata: {
                    signalItemId: result.id,
                    entityId: result.id,
                    sourcePlatform: input.signalData.sourcePlatform,
                    sourceRoute: input.signalData.sourceRoute,
                    topics: input.signalData.topics,
                    relevanceScore: relevance,
                    url: input.signalData.url,
                    authorUsername: input.signalData.authorUsername,
                    authorDisplayName: input.signalData.authorDisplayName,
                  },
                },
                surfaces: [
                  {
                    type: "feed",
                    proactiveOptions: {
                      checkPreferences: true,
                      deduplicate: false, // Allow multiple signals
                      proactiveType: "insight",
                      emitEvents: true,
                      createNotification: input.capture.createNotification,
                      notificationType: "signal",
                    },
                  },
                ],
              });

              feedPosted = deliveryResult.success;
              notificationCreated = input.capture.createNotification;
            } catch (deliveryError) {
              // Log error but don't fail the capture
              console.warn("Failed to deliver signal to feed:", deliveryError);
            }
          }

          const linkedEntities: Array<{
            entityId: string;
            entityType: string;
            entityName: string;
            linkType: string;
            linkStrength: number;
          }> = [];

          if (input.capture.autoLinkEntities) {
            const potentialLinks = await findPotentialEntityLinks(
              input.signalData,
              workspaceId,
              input.capture.linkStrengthThreshold
            );

            for (const link of potentialLinks) {
              await db.insert(signalAutoLinks).values({
                signalEntityId: result.id,
                linkedEntityId: link.entityId,
                linkType: link.linkType,
                linkStrength: String(link.strength),
                linkContext: link.context,
                source: "ai",
                sourceModel: "deepseek-chat",
              });

              linkedEntities.push({
                entityId: link.entityId,
                entityType: link.entityType,
                entityName: link.entityName,
                linkType: link.linkType,
                linkStrength: link.strength,
              });
            }
          }

          return {
            success: true,
            entity: {
              id: result.id,
              profileSlug: "signal_item",
              name: input.signalData.title,
              properties: input.signalData as Record<string, unknown>,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            autoLinking: {
              linkedEntities,
              totalLinked: linkedEntities.length,
            },
            delivery: {
              feedPosted,
              notificationCreated,
            },
            metadata: {
              captureTimestamp: new Date().toISOString(),
              captureMethod: input.capture.captureMethod,
              processingDurationMs: Date.now() - startTime,
            },
          };
        } catch (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to capture signal: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    ),

  /**
   * GET /signals/feed - Get personalized signal feed
   * Requires: hub-protocol.read scope
   */
  feed: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        topics: z.array(z.string()).optional(),
        platforms: z.array(z.enum(SIGNAL_PLATFORMS)).optional(),
        since: z.string().datetime().optional(),
        until: z.string().datetime().optional(),
        useMemory: z.boolean().default(true),
        useSubscriptions: z.boolean().default(true),
        useContext: z.boolean().default(true),
        includeRaw: z.boolean().default(false),
        includeClassification: z.boolean().default(true),
        minRelevance: z.number().min(0).max(1).default(0.1),
        diversification: z.number().min(0).max(1).default(0.3),
        freshnessBoost: z.number().min(0).max(1).default(0.5),
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(
      async ({
        input,
        ctx,
      }): Promise<{
        success: boolean;
        items: Array<{
          id: string;
          sourcePlatform: string;
          sourceRoute: string;
          url: string;
          title: string;
          description?: string;
          publishedAt: string;
          authorUsername?: string;
          authorDisplayName?: string;
          authorUrl?: string;
          aiSummary?: string;
          topics: string[];
          relevanceScore: number;
          sentiment?: string;
          display: {
            cardTitle?: string;
            cardImage?: string;
            cardColor?: string;
            cardEmoji?: string;
            actions: Array<{
              label: string;
              icon: string;
              action: string;
              payload?: unknown;
            }>;
          };
          classification?: {
            model: string;
            timestamp: string;
            extractedEntities?: Array<{
              type: string;
              name: string;
              confidence: number;
            }>;
          };
          rawData?: unknown;
        }>;
        pagination: {
          total: number;
          limit: number;
          offset: number;
          hasMore: boolean;
          nextOffset?: number;
        };
        context: {
          workspaceId: string;
          userId: string;
          personalization: {
            usedMemory: boolean;
            usedSubscriptions: boolean;
            usedContext: boolean;
            topicsConsidered: string[];
            platformsConsidered: string[];
          };
          preferences?: {
            subscriptions: Array<{ topic: string; confidence: number }>;
            classifications: Array<{
              topic: string;
              confidence: number;
              lastUpdated: string;
            }>;
          };
        };
        metadata: {
          fetchDurationMs: number;
          sourcesFetched: number;
          cacheHitRate: number;
          statistics?: {
            averageRelevance: number;
            topicDistribution: Record<string, number>;
            platformDistribution: Record<string, number>;
            freshnessDistribution: Record<string, number>;
          };
        };
        error?: string;
      }> => {
        const startTime = Date.now();
        checkHubRateLimit(ctx.apiKeyId, "signals.feed");

        const {
          limit,
          offset,
          topics,
          platforms,
          useMemory,
          useSubscriptions,
          useContext,
          workspaceId,
        } = input;
        // SECURITY — the caller's OWN identity, never a body-supplied userId
        // (which let any hub key read another user's subscriptions/context).
        const userId = ctx.userId!;

        const signalEntities = await db
          .select()
          .from(entities)
          .where(
            and(
              isNull(entities.deletedAt),
              sql`${entities.properties}->>'capturedFromFeed' = 'true'`
            )
          )
          .orderBy(desc(entities.createdAt))
          .limit(limit)
          .offset(offset);

        const total = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(entities)
          .where(
            and(
              isNull(entities.deletedAt),
              sql`${entities.properties}->>'capturedFromFeed' = 'true'`
            )
          );

        const feedItems = signalEntities.map((entity) => {
          const props = (entity.properties ?? {}) as Record<string, unknown>;
          return {
            id: entity.id,
            sourcePlatform: String(props.sourcePlatform ?? ""),
            sourceRoute: String(props.sourceRoute ?? ""),
            url: String(props.url ?? ""),
            title: entity.title ?? "",
            description: props.description
              ? String(props.description)
              : undefined,
            publishedAt: String(props.publishedAt ?? entity.createdAt),
            authorUsername: props.authorUsername
              ? String(props.authorUsername)
              : undefined,
            authorDisplayName: props.authorDisplayName
              ? String(props.authorDisplayName)
              : undefined,
            authorUrl: props.authorUrl ? String(props.authorUrl) : undefined,
            aiSummary: props.aiSummary ? String(props.aiSummary) : undefined,
            topics: Array.isArray(props.topics)
              ? (props.topics as string[])
              : [],
            relevanceScore: Number(props.relevanceScore ?? 0.5),
            sentiment: props.sentiment ? String(props.sentiment) : undefined,
            display: {
              cardTitle: entity.title ?? undefined,
              cardImage: undefined,
              cardColor: undefined,
              cardEmoji: undefined,
              actions: [
                {
                  label: "Open",
                  icon: "external-link",
                  action: "open",
                  payload: { url: props.url },
                },
                {
                  label: "Share",
                  icon: "share",
                  action: "share",
                  payload: { id: entity.id },
                },
              ],
            },
            classification: input.includeClassification
              ? {
                  model: "deepseek-chat",
                  timestamp: entity.createdAt.toISOString(),
                  extractedEntities: [],
                }
              : undefined,
            rawData: input.includeRaw ? props.rawData : undefined,
          };
        });

        const topicDist: Record<string, number> = {};
        const platformDist: Record<string, number> = {};
        let totalRelevance = 0;

        for (const item of feedItems) {
          totalRelevance += item.relevanceScore;
          for (const topic of item.topics) {
            topicDist[topic] = (topicDist[topic] ?? 0) + 1;
          }
          platformDist[item.sourcePlatform] =
            (platformDist[item.sourcePlatform] ?? 0) + 1;
        }

        const freshnessDist: Record<string, number> = {
          "<1h": 0,
          "<24h": 0,
          "<7d": 0,
          older: 0,
        };

        const now = Date.now();
        for (const item of feedItems) {
          const age = now - new Date(item.publishedAt).getTime();
          if (age < 3600000) freshnessDist["<1h"]++;
          else if (age < 86400000) freshnessDist["<24h"]++;
          else if (age < 604800000) freshnessDist["<7d"]++;
          else freshnessDist["older"]++;
        }

        const subscriptions = input.useSubscriptions
          ? await db
              .select()
              .from(signalSubscriptions)
              .where(
                and(
                  eq(signalSubscriptions.userId, userId),
                  eq(signalSubscriptions.isActive, true)
                )
              )
          : [];

        const classifications = input.useContext
          ? await db
              .select()
              .from(signalClassifications)
              .where(eq(signalClassifications.userId, userId))
          : [];

        return {
          success: true,
          items: feedItems,
          pagination: {
            total: total[0]?.count ?? 0,
            limit,
            offset,
            hasMore: offset + limit < (total[0]?.count ?? 0),
            nextOffset: offset + limit,
          },
          context: {
            workspaceId: workspaceId ?? "",
            userId,
            personalization: {
              usedMemory: useMemory,
              usedSubscriptions: useSubscriptions,
              usedContext: useContext,
              topicsConsidered: topics ?? [],
              platformsConsidered: platforms ?? [],
            },
            preferences: {
              subscriptions: subscriptions.map((s) => ({
                topic: s.topic,
                confidence: Number(s.confidence),
              })),
              classifications: classifications.map((c) => ({
                topic: c.topic,
                confidence: Number(c.confidence),
                lastUpdated: c.lastSeenAt.toISOString(),
              })),
            },
          },
          metadata: {
            fetchDurationMs: Date.now() - startTime,
            sourcesFetched: signalEntities.length,
            cacheHitRate: 0,
            statistics: {
              averageRelevance:
                feedItems.length > 0 ? totalRelevance / feedItems.length : 0,
              topicDistribution: topicDist,
              platformDistribution: platformDist,
              freshnessDistribution: freshnessDist,
            },
          },
        };
      }
    ),

  /**
   * GET /signals/context - Get personalization context for user
   * Requires: hub-protocol.read scope
   */
  context: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        includeSubscriptions: z.boolean().default(true),
        includeClassifications: z.boolean().default(true),
        includeMemory: z.boolean().default(true),
        includeCurrentFocus: z.boolean().default(true),
        includeHistory: z.boolean().default(false),
        historyWindow: z.enum(["7d", "30d", "90d"]).default("7d"),
      })
    )
    .query(
      async ({
        input,
        ctx,
      }): Promise<{
        success: boolean;
        context: {
          workspaceId: string;
          userId: string;
          subscriptions?: Array<{
            id: string;
            topic: string;
            sourcePlatform?: string;
            sourceRoute?: string;
            isActive: boolean;
            confidence: number;
            createdAt: string;
            updatedAt: string;
          }>;
          classifications?: Array<{
            id: string;
            topic: string;
            confidence: number;
            sourceType: string;
            occurrenceCount: number;
            firstSeenAt: string;
            lastSeenAt: string;
            decayedConfidence: number;
          }>;
          memory?: {
            recentTopics: Array<{
              topic: string;
              frequency: number;
              lastMentioned: string;
            }>;
            entityAffinities: Array<{
              entityId: string;
              entityType: string;
              entityName: string;
              affinity: number;
              interactionCount: number;
            }>;
            temporalPatterns?: {
              activeHours: number[];
              peakDays: string[];
            };
          };
          currentFocus?: {
            activeTasks: Array<{
              id: string;
              name: string;
              status: string;
              dueDate?: string;
            }>;
            recentSearches: string[];
            discussedPeople: Array<{
              entityId: string;
              name: string;
              mentionCount: number;
              lastMentioned: string;
            }>;
            viewedEntities: Array<{
              entityId: string;
              entityType: string;
              name: string;
              viewCount: number;
              lastViewed: string;
            }>;
          };
          history?: {
            captures: Array<{ date: string; count: number; topics: string[] }>;
            views: Array<{
              date: string;
              count: number;
              averageDwellTime: number;
            }>;
            searches: Array<{ date: string; queries: string[] }>;
          };
        };
        metadata: {
          generatedAt: string;
          processingDurationMs: number;
          dataFreshness: {
            subscriptions: string;
            classifications: string;
            memory: string;
            currentFocus: string;
          };
        };
        error?: string;
      }> => {
        const startTime = Date.now();
        const { workspaceId } = input;
        // SECURITY — the caller's OWN identity, never a body-supplied userId.
        const userId = ctx.userId!;

        const subscriptions = input.includeSubscriptions
          ? await db
              .select()
              .from(signalSubscriptions)
              .where(
                and(
                  eq(signalSubscriptions.userId, userId),
                  eq(signalSubscriptions.workspaceId, workspaceId)
                )
              )
          : [];

        const classifications = input.includeClassifications
          ? await db
              .select()
              .from(signalClassifications)
              .where(
                and(
                  eq(signalClassifications.userId, userId),
                  eq(signalClassifications.workspaceId, workspaceId)
                )
              )
          : [];

        const now = new Date();
        const decayFactor = 0.95;

        return {
          success: true,
          context: {
            workspaceId,
            userId,
            subscriptions: subscriptions.map((s) => ({
              id: s.id,
              topic: s.topic,
              sourcePlatform: s.sourcePlatform ?? undefined,
              sourceRoute: s.sourceRoute ?? undefined,
              isActive: s.isActive,
              confidence: Number(s.confidence),
              createdAt: s.createdAt.toISOString(),
              updatedAt: s.updatedAt.toISOString(),
            })),
            classifications: classifications.map((c) => {
              const daysSinceUpdate =
                (now.getTime() - c.lastSeenAt.getTime()) /
                (1000 * 60 * 60 * 24);
              const decayedConfidence =
                Number(c.confidence) * Math.pow(decayFactor, daysSinceUpdate);
              return {
                id: c.id,
                topic: c.topic,
                confidence: Number(c.confidence),
                sourceType: c.sourceType,
                occurrenceCount: c.occurrenceCount,
                firstSeenAt: c.firstSeenAt.toISOString(),
                lastSeenAt: c.lastSeenAt.toISOString(),
                decayedConfidence,
              };
            }),
            memory: input.includeMemory
              ? {
                  recentTopics: [],
                  entityAffinities: [],
                  temporalPatterns: {
                    activeHours: [],
                    peakDays: [],
                  },
                }
              : undefined,
            currentFocus: input.includeCurrentFocus
              ? {
                  activeTasks: [],
                  recentSearches: [],
                  discussedPeople: [],
                  viewedEntities: [],
                }
              : undefined,
          },
          metadata: {
            generatedAt: now.toISOString(),
            processingDurationMs: Date.now() - startTime,
            dataFreshness: {
              subscriptions: "5 minutes ago",
              classifications: "10 minutes ago",
              memory: "1 hour ago",
              currentFocus: "5 minutes ago",
            },
          },
        };
      }
    ),

  /**
   * POST /signals/subscriptions - Manage signal subscriptions
   * Requires: hub-protocol.write scope
   */
  subscriptions: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        userId: z.string(),
        operations: z.array(
          z.discriminatedUnion("operation", [
            z.object({
              operation: z.literal("create"),
              subscription: z.object({
                topic: z.string().min(1),
                sourcePlatform: z.string().optional(),
                sourceRoute: z.string().optional(),
                confidence: z.number().min(0).max(1).optional(),
                notificationPreference: z
                  .enum(["none", "digest", "immediate"])
                  .optional(),
              }),
            }),
            z.object({
              operation: z.literal("update"),
              subscriptionId: z.string(),
              subscription: z.object({
                topic: z.string().min(1).optional(),
                sourcePlatform: z.string().optional(),
                sourceRoute: z.string().optional(),
                confidence: z.number().min(0).max(1).optional(),
                notificationPreference: z
                  .enum(["none", "digest", "immediate"])
                  .optional(),
              }),
            }),
            z.object({
              operation: z.literal("delete"),
              subscriptionId: z.string(),
            }),
            z.object({
              operation: z.literal("toggle"),
              subscriptionId: z.string(),
              isActive: z.boolean(),
            }),
          ])
        ),
      })
    )
    .mutation(
      async ({
        input,
        ctx,
      }): Promise<{
        success: boolean;
        results: Array<{
          operation: string;
          subscriptionId?: string;
          success: boolean;
          error?: string;
          subscription?: {
            id: string;
            topic: string;
            sourcePlatform?: string;
            sourceRoute?: string;
            isActive: boolean;
            confidence: number;
            notificationPreference: string;
            createdAt: string;
            updatedAt: string;
          };
        }>;
        metadata: {
          processedAt: string;
          totalOperations: number;
          successfulOperations: number;
        };
        error?: string;
      }> => {
        checkHubRateLimit(ctx.apiKeyId, "signals.subscriptions");

        // SECURITY — mutate ONLY the caller's own subscriptions. Identity comes
        // from the authenticated key owner, never a body-supplied userId, and
        // every update/delete/toggle is floored by an owner predicate so a bare
        // subscriptionId can't reach across users.
        const actingUserId = ctx.userId!;

        const results = [];
        let successfulCount = 0;

        for (const op of input.operations) {
          try {
            if (op.operation === "create") {
              const id = randomUUID();
              await db.insert(signalSubscriptions).values({
                id,
                userId: actingUserId,
                workspaceId: input.workspaceId,
                topic: op.subscription!.topic,
                sourcePlatform: op.subscription!.sourcePlatform,
                sourceRoute: op.subscription!.sourceRoute,
                confidence: String(op.subscription!.confidence ?? 0.5),
                notificationPreference:
                  op.subscription!.notificationPreference ?? "none",
              });

              const created = await db.query.signalSubscriptions.findFirst({
                where: eq(signalSubscriptions.id, id),
              });

              if (created) {
                successfulCount++;
                results.push({
                  operation: "create",
                  subscriptionId: id,
                  success: true,
                  subscription: {
                    id: created.id,
                    topic: created.topic,
                    sourcePlatform: created.sourcePlatform ?? undefined,
                    sourceRoute: created.sourceRoute ?? undefined,
                    isActive: created.isActive,
                    confidence: Number(created.confidence),
                    notificationPreference: created.notificationPreference,
                    createdAt: created.createdAt.toISOString(),
                    updatedAt: created.updatedAt.toISOString(),
                  },
                });
              }
            } else if (op.operation === "update") {
              const updates: Record<string, unknown> = {};
              if (op.subscription?.topic) updates.topic = op.subscription.topic;
              if (op.subscription?.sourcePlatform)
                updates.sourcePlatform = op.subscription.sourcePlatform;
              if (op.subscription?.sourceRoute)
                updates.sourceRoute = op.subscription.sourceRoute;
              if (op.subscription?.confidence !== undefined)
                updates.confidence = String(op.subscription.confidence);
              if (op.subscription?.notificationPreference)
                updates.notificationPreference =
                  op.subscription.notificationPreference;

              if (Object.keys(updates).length > 0) {
                await db
                  .update(signalSubscriptions)
                  .set(updates)
                  .where(
                    and(
                      eq(signalSubscriptions.id, op.subscriptionId!),
                      eq(signalSubscriptions.userId, actingUserId)
                    )
                  );

                successfulCount++;
              }

              const updated = await db.query.signalSubscriptions.findFirst({
                where: and(
                  eq(signalSubscriptions.id, op.subscriptionId!),
                  eq(signalSubscriptions.userId, actingUserId)
                ),
              });

              if (updated) {
                results.push({
                  operation: "update",
                  subscriptionId: op.subscriptionId,
                  success: true,
                  subscription: {
                    id: updated.id,
                    topic: updated.topic,
                    sourcePlatform: updated.sourcePlatform ?? undefined,
                    sourceRoute: updated.sourceRoute ?? undefined,
                    isActive: updated.isActive,
                    confidence: Number(updated.confidence),
                    notificationPreference: updated.notificationPreference,
                    createdAt: updated.createdAt.toISOString(),
                    updatedAt: updated.updatedAt.toISOString(),
                  },
                });
              }
            } else if (op.operation === "delete") {
              await db
                .delete(signalSubscriptions)
                .where(
                  and(
                    eq(signalSubscriptions.id, op.subscriptionId!),
                    eq(signalSubscriptions.userId, actingUserId)
                  )
                );

              successfulCount++;
              results.push({
                operation: "delete",
                subscriptionId: op.subscriptionId,
                success: true,
              });
            } else if (op.operation === "toggle") {
              await db
                .update(signalSubscriptions)
                .set({ isActive: op.isActive })
                .where(
                  and(
                    eq(signalSubscriptions.id, op.subscriptionId!),
                    eq(signalSubscriptions.userId, actingUserId)
                  )
                );

              successfulCount++;

              const toggled = await db.query.signalSubscriptions.findFirst({
                where: and(
                  eq(signalSubscriptions.id, op.subscriptionId!),
                  eq(signalSubscriptions.userId, actingUserId)
                ),
              });

              if (toggled) {
                results.push({
                  operation: "toggle",
                  subscriptionId: op.subscriptionId,
                  success: true,
                  subscription: {
                    id: toggled.id,
                    topic: toggled.topic,
                    sourcePlatform: toggled.sourcePlatform ?? undefined,
                    sourceRoute: toggled.sourceRoute ?? undefined,
                    isActive: toggled.isActive,
                    confidence: Number(toggled.confidence),
                    notificationPreference: toggled.notificationPreference,
                    createdAt: toggled.createdAt.toISOString(),
                    updatedAt: toggled.updatedAt.toISOString(),
                  },
                });
              }
            }
          } catch (error) {
            results.push({
              operation: op.operation,
              subscriptionId:
                "subscriptionId" in op ? op.subscriptionId : undefined,
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }

        return {
          success: true,
          results,
          metadata: {
            processedAt: new Date().toISOString(),
            totalOperations: input.operations.length,
            successfulOperations: successfulCount,
          },
        };
      }
    ),

  /**
   * POST /signals/batch - Execute multiple operations with dependencies
   * Requires: hub-protocol.write scope
   */
  batch: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        userId: z.string(),
        operations: z.array(
          z.object({
            type: z.enum(["fetch", "classify", "capture"]),
            id: z.string(),
            data: z.record(z.string(), z.unknown()),
            dependsOn: z.array(z.string()).optional(),
          })
        ),
        options: z
          .object({
            maxConcurrency: z.number().int().min(1).max(10).default(3),
            stopOnError: z.boolean().default(false),
            timeoutMs: z.number().int().min(1000).max(120000).default(60000),
          })
          .optional(),
      })
    )
    .mutation(
      async ({
        input,
        ctx,
      }): Promise<{
        success: boolean;
        operations: Array<{
          id: string;
          type: string;
          success: boolean;
          durationMs: number;
          result?: unknown;
          error?: { code: string; message: string; details?: unknown };
        }>;
        metadata: {
          totalOperations: number;
          successfulOperations: number;
          failedOperations: number;
          totalDurationMs: number;
          averageDurationMs: number;
        };
        error?: string;
      }> => {
        // Authorize the acting identity ONCE, up front: `input.userId` is
        // forwarded into the fetch/classify/capture sub-callers, so a body-
        // supplied foreign userId must be rejected before any op runs (capture
        // re-guards, but fetch/classify would silently act) — the same W0.5
        // impersonation floor the individual mutations carry.
        assertMayActAs(ctx, input.userId);

        const startTime = Date.now();
        const maxConcurrency = input.options?.maxConcurrency ?? 3;
        const stopOnError = input.options?.stopOnError ?? false;

        const results = new Map<
          string,
          {
            id: string;
            type: string;
            success: boolean;
            durationMs: number;
            result?: unknown;
            error?: { code: string; message: string; details?: unknown };
          }
        >();

        const pending = [...input.operations];
        const executing: Promise<void>[] = [];
        const completed = new Set<string>();

        const executeOp = async (
          op: (typeof input.operations)[0]
        ): Promise<void> => {
          const opStartTime = Date.now();

          if (op.dependsOn && op.dependsOn.length > 0) {
            for (const depId of op.dependsOn) {
              while (!completed.has(depId) && results.has(depId)) {
                const depResult = results.get(depId);
                if (!depResult?.success) {
                  results.set(op.id, {
                    id: op.id,
                    type: op.type,
                    success: false,
                    durationMs: 0,
                    error: {
                      code: "DEPENDENCY_FAILED",
                      message: `Operation ${op.id} depends on failed operation ${depId}`,
                    },
                  });
                  completed.add(op.id);
                  return;
                }
                await new Promise((r) => setTimeout(r, 10));
              }
              await new Promise((r) => setTimeout(r, 50));
            }
          }

          try {
            let result: unknown;

            if (op.type === "fetch") {
              const fetchData = op.data as {
                sourceRoute: string;
                sourcePlatform: string;
                options?: {
                  limit?: number;
                  since?: string;
                  forceRefresh?: boolean;
                };
              };
              const fetchResult = await signalsRouter.createCaller(ctx).fetch({
                sourceRoute: fetchData.sourceRoute,
                sourcePlatform: fetchData.sourcePlatform as SignalPlatform,
                options: fetchData.options,
                context: {
                  workspaceId: input.workspaceId,
                  userId: input.userId,
                },
              });
              result = fetchResult;
            } else if (op.type === "classify") {
              const classifyData = op.data as {
                items: RssHubItem[];
                classification?: {
                  mode?: "quick" | "detailed" | "comprehensive";
                  extractTopics?: boolean;
                  computeRelevance?: boolean;
                  extractEntities?: boolean;
                  generateSummary?: boolean;
                };
              };
              const classifyResult = await signalsRouter
                .createCaller(ctx)
                .classify({
                  items: classifyData.items,
                  classification: classifyData.classification,
                  context: {
                    workspaceId: input.workspaceId,
                    userId: input.userId,
                  },
                });
              result = classifyResult;
            } else if (op.type === "capture") {
              const captureData = op.data as {
                signalData: {
                  sourcePlatform: SignalPlatform;
                  sourceRoute: string;
                  url: string;
                  title: string;
                  description?: string;
                  publishedAt: string;
                  authorUsername?: string;
                  authorDisplayName?: string;
                  authorUrl?: string;
                  aiSummary?: string;
                  topics: string[];
                  relevanceScore?: number;
                };
                capture?: {
                  captureMethod?: "manual" | "automation" | "ai_suggestion";
                  autoLinkEntities?: boolean;
                };
              };
              const captureResult = await signalsRouter
                .createCaller(ctx)
                .capture({
                  signalData: captureData.signalData,
                  capture: {
                    workspaceId: input.workspaceId,
                    userId: input.userId,
                    captureMethod:
                      captureData.capture?.captureMethod ?? "automation",
                    autoLinkEntities:
                      captureData.capture?.autoLinkEntities ?? true,
                  },
                });
              result = captureResult;
            }

            results.set(op.id, {
              id: op.id,
              type: op.type,
              success: true,
              durationMs: Date.now() - opStartTime,
              result,
            });
            completed.add(op.id);
          } catch (error) {
            results.set(op.id, {
              id: op.id,
              type: op.type,
              success: false,
              durationMs: Date.now() - opStartTime,
              error: {
                code: "OPERATION_FAILED",
                message: error instanceof Error ? error.message : String(error),
              },
            });
            completed.add(op.id);

            if (stopOnError) {
              for (const pendingOp of pending) {
                if (!completed.has(pendingOp.id)) {
                  results.set(pendingOp.id, {
                    id: pendingOp.id,
                    type: pendingOp.type,
                    success: false,
                    durationMs: 0,
                    error: {
                      code: "SKIPPED",
                      message: "Stopped due to earlier error",
                    },
                  });
                  completed.add(pendingOp.id);
                }
              }
            }
          }
        };

        while (pending.length > 0 || executing.length > 0) {
          while (executing.length < maxConcurrency && pending.length > 0) {
            const op = pending.shift()!;
            executing.push(
              executeOp(op).finally(() =>
                executing.splice(
                  executing.indexOf(executeOp as unknown as Promise<void>),
                  1
                )
              )
            );
          }
          if (executing.length > 0) {
            await Promise.race(executing);
          }
        }

        await Promise.all(executing);

        const allResults = Array.from(results.values());
        const successful = allResults.filter((r) => r.success).length;
        const failed = allResults.filter((r) => !r.success).length;
        const totalDuration = Date.now() - startTime;

        return {
          success: failed === 0,
          operations: allResults,
          metadata: {
            totalOperations: input.operations.length,
            successfulOperations: successful,
            failedOperations: failed,
            totalDurationMs: totalDuration,
            averageDurationMs:
              allResults.length > 0 ? totalDuration / allResults.length : 0,
          },
        };
      }
    ),
});

function parseRssXml(xml: string): RssHubItem[] {
  const items: RssHubItem[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const contentRegex =
    /<(\w+)[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/\1>|<(\w+)[^>]*>([\s\S]*?)<\/\3>/gi;

  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemContent = match[1];
    const item: RssHubItem = {};

    let fieldMatch;
    while ((fieldMatch = contentRegex.exec(itemContent)) !== null) {
      const [, cdataKey, cdataVal, normKey, normVal] = fieldMatch;
      const key = cdataKey ?? normKey;
      const value = (cdataVal ?? normVal).trim();
      if (key === "title") item.title = value;
      else if (key === "link") item.link = value;
      else if (key === "description") item.description = value;
      else if (key === "pubDate") item.pubDate = value;
      else if (key === "author" || key === "dc:creator") item.author = value;
      else if (key === "guid") item.guid = value;
    }

    if (item.link || item.title) {
      items.push(item);
    }
  }

  return items;
}

function extractTopicsFromItem(
  item: RssHubItem,
  userPreferences?: {
    subscriptions?: Array<{ topic: string; confidence: number }>;
    classifications?: Array<{ topic: string; confidence: number }>;
  }
): Array<{ name: string; confidence: number; source: string }> {
  const topics: Array<{ name: string; confidence: number; source: string }> =
    [];
  const content = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();

  const topicKeywords: Record<string, string[]> = {
    ai: [
      "ai",
      "artificial intelligence",
      "machine learning",
      "llm",
      "gpt",
      "neural",
    ],
    technology: ["tech", "software", "developer", "programming", "code"],
    science: [
      "science",
      "research",
      "study",
      "discovery",
      "physics",
      "biology",
    ],
    business: [
      "business",
      "startup",
      "company",
      "market",
      "economy",
      "investment",
    ],
    space: ["space", "nasa", "rocket", "satellite", "mars", "asteroid"],
    politics: ["politics", "government", "election", "policy", "congress"],
    entertainment: [
      "movie",
      "film",
      "tv",
      "show",
      "music",
      "game",
      "streaming",
    ],
    health: ["health", "medical", "disease", "treatment", "doctor", "hospital"],
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    const matches = keywords.filter((kw) => content.includes(kw));
    if (matches.length > 0) {
      let confidence = 0.3 + matches.length * 0.15;
      if (userPreferences?.subscriptions) {
        const sub = userPreferences.subscriptions.find(
          (s) => s.topic.toLowerCase() === topic
        );
        if (sub) confidence = Math.max(confidence, sub.confidence);
      }
      topics.push({
        name: topic,
        confidence: Math.min(confidence, 1.0),
        source: "inferred",
      });
    }
  }

  if (topics.length === 0) {
    topics.push({ name: "general", confidence: 0.5, source: "inferred" });
  }

  return topics;
}

function computeRelevanceScore(
  item: RssHubItem,
  userPreferences?: {
    subscriptions?: Array<{ topic: string; confidence: number }>;
    classifications?: Array<{ topic: string; confidence: number }>;
  }
): number {
  const content = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
  let score = 0.5;

  if (userPreferences?.subscriptions) {
    for (const sub of userPreferences.subscriptions) {
      const topic = sub.topic.toLowerCase();
      if (content.includes(topic)) {
        score += sub.confidence * 0.3;
      }
    }
  }

  if (userPreferences?.classifications) {
    for (const cls of userPreferences.classifications) {
      const topic = cls.topic.toLowerCase();
      if (content.includes(topic)) {
        score += cls.confidence * 0.2;
      }
    }
  }

  return Math.min(Math.max(score, 0), 1);
}

function extractEntitiesFromItem(
  item: RssHubItem
): Array<{ type: string; name: string; confidence: number; context?: string }> {
  const entities: Array<{
    type: string;
    name: string;
    confidence: number;
    context?: string;
  }> = [];
  const content = `${item.title ?? ""} ${item.description ?? ""}`;

  const twitterHandleRegex = /@([a-zA-Z0-9_]+)/g;
  const urlRegex = /https?:\/\/([^/]+)/g;

  let match;
  while ((match = twitterHandleRegex.exec(content)) !== null) {
    entities.push({
      type: "person",
      name: match[1],
      confidence: 0.7,
      context: "twitter handle",
    });
  }

  while ((match = urlRegex.exec(content)) !== null) {
    const domain = match[1];
    if (!domain.includes("synap")) {
      entities.push({
        type: "company",
        name: domain,
        confidence: 0.4,
        context: "mentioned domain",
      });
    }
  }

  return entities.slice(0, 5);
}

function generateSummary(item: RssHubItem): string {
  const title = item.title ?? "Untitled";
  const description = item.description ?? "";
  const summary = description.slice(0, 200);
  return `${title}: ${summary}${description.length > 200 ? "..." : ""}`;
}

async function findPotentialEntityLinks(
  signalData: {
    topics: string[];
    url?: string;
    authorUsername?: string;
  },
  workspaceId: string,
  threshold: number
): Promise<
  Array<{
    entityId: string;
    entityType: string;
    entityName: string;
    linkType: string;
    strength: number;
    context?: string;
  }>
> {
  const links: Array<{
    entityId: string;
    entityType: string;
    entityName: string;
    linkType: string;
    strength: number;
    context?: string;
  }> = [];

  if (signalData.authorUsername) {
    const personEntities = await db
      .select({
        id: entities.id,
        title: entities.title,
        properties: entities.properties,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          sql`${entities.properties}->>'authorUsername' = ${signalData.authorUsername}`
        )
      )
      .limit(3);

    for (const entity of personEntities) {
      links.push({
        entityId: entity.id,
        entityType: "person",
        entityName: entity.title ?? "",
        linkType: "author",
        strength: 0.8,
        context: "Same author",
      });
    }
  }

  return links.filter((l) => l.strength >= threshold);
}
