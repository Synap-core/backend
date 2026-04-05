/**
 * Hub Protocol Router
 *
 * Handles communication with Intelligence Hub services.
 * This is the tRPC endpoint that Intelligence Hub calls to submit insights.
 */

import { z } from "zod";
import { router, protectedProcedure, publicProcedure } from "../trpc.js";
import { t } from "../init-trpc.js";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  generateHubAccessToken,
  validateHubToken,
  logHubAccess,
  type HubTokenPayload,
} from "./hub-utils.js";
import { transformInsightToEvents } from "./hub-transform.js";
import { validateHubInsight, type HubInsight } from "@synap-core/hub-protocol";
import { getEventRepository } from "@synap/database";
import { db, entities } from "@synap/database";
import { eq, and, desc, gte, lte } from "@synap/database";
// SQL type no longer needed — queryEntities uses collect-then-spread pattern

const logger = createLogger({ module: "hub-router" });

const ScopeEnum = z.enum([
  "preferences",
  "calendar",
  "notes",
  "tasks",
  "projects",
  "conversations",
  "entities",
  "relations",
  "knowledge_facts",
]);

const GenerateAccessTokenInputSchema = z.object({
  requestId: z.string().uuid("Invalid request ID"),
  scope: z.array(ScopeEnum).min(1, "At least one scope is required"),
  expiresIn: z.number().int().min(1).max(300).default(300),
});

const RequestDataInputSchema = z.object({
  token: z.string().min(1, "Token is required"),
  scope: z.array(ScopeEnum).min(1, "At least one scope is required"),
  filters: z
    .object({
      dateRange: z
        .object({
          start: z.string().datetime(),
          end: z.string().datetime(),
        })
        .optional(),
      entityTypes: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().nonnegative().default(0),
    })
    .optional(),
});

const SubmitInsightInputSchema = z.object({
  token: z.string().min(1, "Token is required"),
  insight: z.any(),
});

// DISABLED - endpoint commented out
// const SemanticSearchInputSchema = z.object({
//   token: z.string().min(1, 'Token is required'),
//   query: z.string().min(1, 'Query is required'),
//   limit: z.number().int().min(1).max(100).default(10),
// });

const hubTokenMiddleware = t.middleware(async (opts) => {
  const { input, ctx } = opts;
  const token = (input as { token?: string })?.token;
  if (!token) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Token is required",
    });
  }
  const payload = validateHubToken(token);
  if (!payload) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or expired token",
    });
  }
  return opts.next({
    ctx: {
      ...ctx,
      hubToken: payload,
    },
  });
});

export const hubTokenProcedure = publicProcedure
  .input(z.object({ token: z.string().min(1) }).passthrough())
  .use(hubTokenMiddleware);

async function getPreferences(
  userId: string
): Promise<Record<string, unknown>> {
  logger.debug({ userId }, "Retrieving preferences (placeholder)");
  return {};
}

async function getCalendar(
  userId: string
): Promise<Array<Record<string, unknown>>> {
  logger.debug({ userId }, "Retrieving calendar (placeholder)");
  return [];
}

async function getNotes(
  userId: string,
  filters?: {
    dateRange?: { start: string; end: string };
    limit?: number;
    offset?: number;
  }
): Promise<Array<Record<string, unknown>>> {
  logger.debug({ userId, filters }, "Retrieving notes");
  return queryEntities(userId, { entityType: "note", ...filters });
}

/**
 * Shared entity query builder — single source of truth for getNotes/getTasks/getProjects/getAllEntities.
 * Uses the collect-then-spread pattern for Drizzle conditions (no `as any`).
 */
async function queryEntities(
  userId: string,
  options?: {
    entityType?: string;
    entityTypes?: string[];
    dateRange?: { start: string; end: string };
    limit?: number;
    offset?: number;
  }
): Promise<Array<Record<string, unknown>>> {
  const conditions = [eq(entities.userId, userId)];

  if (options?.entityType) {
    conditions.push(eq(entities.type, options.entityType));
  } else if (options?.entityTypes?.length) {
    conditions.push(eq(entities.type, options.entityTypes[0]));
  }

  if (options?.dateRange) {
    conditions.push(
      gte(entities.createdAt, new Date(options.dateRange.start)),
      lte(entities.createdAt, new Date(options.dateRange.end))
    );
  }

  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      preview: entities.preview,
      type: entities.type,
      createdAt: entities.createdAt,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(and(...conditions))
    .orderBy(desc(entities.createdAt))
    .limit(options?.limit || 100)
    .offset(options?.offset || 0);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    preview: row.preview,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function getTasks(
  userId: string,
  filters?: {
    dateRange?: { start: string; end: string };
    limit?: number;
    offset?: number;
  }
): Promise<Array<Record<string, unknown>>> {
  logger.debug({ userId, filters }, "Retrieving tasks");
  return queryEntities(userId, { entityType: "task", ...filters });
}

async function getProjects(
  userId: string,
  filters?: {
    dateRange?: { start: string; end: string };
    limit?: number;
    offset?: number;
  }
): Promise<Array<Record<string, unknown>>> {
  logger.debug({ userId, filters }, "Retrieving projects");
  return queryEntities(userId, { entityType: "project", ...filters });
}

async function getConversations(
  userId: string
): Promise<Array<Record<string, unknown>>> {
  logger.debug({ userId }, "Retrieving conversations (placeholder)");
  return [];
}

async function getAllEntities(
  userId: string,
  filters?: {
    dateRange?: { start: string; end: string };
    entityTypes?: string[];
    limit?: number;
    offset?: number;
  }
): Promise<Array<Record<string, unknown>>> {
  logger.debug({ userId, filters }, "Retrieving all entities");
  return queryEntities(userId, filters);
}

async function getRelations(
  userId: string
): Promise<Array<Record<string, unknown>>> {
  logger.debug({ userId }, "Retrieving relations (placeholder)");
  return [];
}

async function getKnowledgeFacts(
  userId: string
): Promise<Array<Record<string, unknown>>> {
  logger.debug({ userId }, "Retrieving knowledge facts (placeholder)");
  return [];
}

export const hubRouter = router({
  generateAccessToken: protectedProcedure
    .input(GenerateAccessTokenInputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string;
      const { requestId, scope, expiresIn } = input;
      logger.info(
        { userId, requestId, scope, expiresIn },
        "Generating Hub access token"
      );
      const { token, expiresAt } = generateHubAccessToken(
        userId,
        requestId,
        scope,
        expiresIn
      );
      await logHubAccess(userId, requestId, "token.generated", {
        scope,
        expiresIn,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      return { token, expiresAt, requestId };
    }),

  requestData: hubTokenProcedure
    .input(RequestDataInputSchema)
    .query(async ({ ctx, input }) => {
      const tokenPayload = ctx.hubToken as HubTokenPayload;
      const { userId, requestId, scope: tokenScope } = tokenPayload;
      const { scope: requestedScope, filters } = input;
      logger.info({ userId, requestId, requestedScope }, "Hub requesting data");
      const invalidScopes = requestedScope.filter(
        (s) => !tokenScope.includes(s)
      );
      if (invalidScopes.length > 0) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Token does not have access to scopes: ${invalidScopes.join(", ")}`,
        });
      }
      const data: Record<string, unknown> = {};
      let totalRecordCount = 0;
      for (const scopeItem of requestedScope) {
        switch (scopeItem) {
          case "preferences":
            data.preferences = await getPreferences(userId);
            break;
          case "calendar":
            data.calendar = await getCalendar(userId);
            totalRecordCount += (data.calendar as Array<unknown>).length;
            break;
          case "notes":
            data.notes = await getNotes(userId, filters);
            totalRecordCount += (data.notes as Array<unknown>).length;
            break;
          case "tasks":
            data.tasks = await getTasks(userId, filters);
            totalRecordCount += (data.tasks as Array<unknown>).length;
            break;
          case "projects":
            data.projects = await getProjects(userId, filters);
            totalRecordCount += (data.projects as Array<unknown>).length;
            break;
          case "conversations":
            data.conversations = await getConversations(userId);
            totalRecordCount += (data.conversations as Array<unknown>).length;
            break;
          case "entities":
            data.entities = await getAllEntities(userId, filters);
            totalRecordCount += (data.entities as Array<unknown>).length;
            break;
          case "relations":
            data.relations = await getRelations(userId);
            totalRecordCount += (data.relations as Array<unknown>).length;
            break;
          case "knowledge_facts":
            data.knowledge_facts = await getKnowledgeFacts(userId);
            totalRecordCount += (data.knowledge_facts as Array<unknown>).length;
            break;
        }
      }
      await logHubAccess(userId, requestId, "data.requested", {
        scope: requestedScope,
        recordCount: totalRecordCount,
        filters,
      });
      return {
        userId,
        requestId,
        data,
        metadata: {
          retrievedAt: new Date().toISOString(),
          scope: requestedScope,
          recordCount: totalRecordCount,
        },
      };
    }),

  submitInsight: hubTokenProcedure
    .input(SubmitInsightInputSchema)
    .mutation(async ({ ctx, input }) => {
      const tokenPayload = ctx.hubToken as HubTokenPayload;
      const { userId, requestId } = tokenPayload;
      const { insight: rawInsight } = input;
      logger.info({ userId, requestId }, "Hub submitting insight");
      let insight: HubInsight;
      try {
        insight = validateHubInsight(rawInsight);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid insight schema: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
      if (insight.correlationId !== requestId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Correlation ID mismatch. Expected: ${requestId}, Got: ${insight.correlationId}`,
        });
      }
      const eventIds: string[] = [];
      const errors: Array<{ actionIndex: number; error: string }> = [];
      if (insight.type === "action_plan" || insight.type === "automation") {
        try {
          const events = await transformInsightToEvents(
            insight,
            userId,
            requestId
          );
          const eventRepo = getEventRepository();
          for (const event of events) {
            try {
              await eventRepo.append(event);
              eventIds.push(event.id);
            } catch (error) {
              errors.push({
                actionIndex: events.indexOf(event),
                error: error instanceof Error ? error.message : "Unknown error",
              });
            }
          }
        } catch (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to transform insight: ${error instanceof Error ? error.message : "Unknown error"}`,
          });
        }
      } else {
        logger.debug(
          { userId, requestId, insightType: insight.type },
          "Insight type does not create events"
        );
      }
      await logHubAccess(userId, requestId, "insight.submitted", {
        insightType: insight.type,
        eventsCreated: eventIds.length,
        confidence: insight.confidence,
        hasActions: insight.actions?.length || 0,
        hasAnalysis: insight.analysis ? true : false,
      });
      return {
        success: errors.length === 0,
        requestId,
        eventIds,
        eventsCreated: eventIds.length,
        errors: errors.length > 0 ? errors : undefined,
      };
    }),

  /**
   * Semantic Search - TEMPORARILY DISABLED
   *
   * Depends on @synap/domain which was removed.
   *
   * TODO: Refactor to use searchEntityVectorsRaw directly from @synap/database
   */
  /* DISABLED - Domain package removed
  semanticSearch: hubTokenProcedure
    .input(SemanticSearchInputSchema)
    .query(async ({ ctx, input }) => {
      const tokenPayload = ctx.hubToken as HubTokenPayload;
      const { userId, requestId } = tokenPayload;
      const { query, limit } = input;

      logger.info({ userId, requestId, queryLength: query.length, limit }, 'Hub semantic search request');

      try {
        // Step 1: Generate embedding from query text
        const { generateEmbedding } = await import('@synap/ai-embeddings');
        const embedding = await generateEmbedding(query);

        // Step 2: Search entities by embedding similarity
        const { vectorService } = await import('@synap/domain');
        const results = await vectorService.searchByEmbedding({
          userId,
          embedding,
          limit,
        });

        // Step 3: Transform results to match SemanticSearchResult format
        const searchResults = results.map((result) => ({
          entityId: result.entityId,
          title: result.title || 'Untitled',
          type: result.entityType,
          preview: result.preview || undefined,
          fileUrl: result.fileUrl || undefined,
          relevanceScore: result.relevanceScore,
        }));

        await logHubAccess(userId, requestId, 'semantic.search', {
          queryLength: query.length,
          resultsCount: searchResults.length,
        });

        logger.info({ userId, requestId, resultsCount: searchResults.length }, 'Semantic search completed');

        return {
          results: searchResults,
          query,
          limit,
          count: searchResults.length,
        };
      } catch (error) {
        logger.error({ err: error, userId, requestId, query: query.slice(0, 50) }, 'Semantic search failed');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Semantic search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }),
  */
});
