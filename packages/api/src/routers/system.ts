/**
 * System Router - Control Tower API
 *
 * This router provides meta-information about the Synap system:
 * - System capabilities (event types, handlers, tools, routers)
 * - Event publishing for testing/debugging
 * - System statistics
 *
 * Used by the admin dashboard to visualize and interact with the system.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  publicProcedure,
  protectedProcedure,
  podAdminProcedure,
  router,
} from "../trpc.js";
import { EventTypeSchemas } from "@synap-core/core";
import { getAllEventTypes } from "@synap/events";
import { getAllGeneratedEventTypes, parseEventType } from "@synap/events";
import { testConnection } from "@synap/search";
import { dynamicToolRegistry } from "@synap/ai";
import { dynamicRouterRegistry } from "../router-registry.js";
import { createSynapEvent } from "@synap-core/core";
import { eventRepository } from "@synap/database";
import { eventStreamManager } from "../event-stream-manager.js";
import { db, eq, sqlDrizzle } from "@synap/database";
import {
  users,
  workspaces,
  entities,
  documents,
  workspaceMembers,
} from "@synap/database/schema";
import { count } from "@synap/database";
import {
  getDynamicCorsOrigins,
  setDynamicCorsOrigins,
} from "../utils/cors-cache.js";

/**
 * System Router
 */
export const systemRouter = router({
  /**
   * Get system capabilities
   *
   * Returns all registered event types, handlers, tools, and routers.
   * This gives a complete overview of the system's architecture.
   */
  getCapabilities: publicProcedure.query(async () => {
    // Get all event types - combine custom/legacy + generated
    const customEventTypes = getAllEventTypes().map((type) => ({
      type,
      hasSchema: type in EventTypeSchemas,
      category: "custom" as const,
    }));

    const generatedEventTypes = getAllGeneratedEventTypes().map((type) => {
      const parsed = parseEventType(type);
      return {
        type,
        hasSchema: true, // Generated events always have schemas
        category: "generated" as const,
        table: parsed?.table,
        action: parsed?.action,
      };
    });

    const eventTypes = [...generatedEventTypes, ...customEventTypes];

    // Get all workers from registry
    const { getAllWorkers } = await import("@synap/jobs");
    const workers = getAllWorkers();

    // Get all tools
    const toolsStats = dynamicToolRegistry.getStats();
    const tools = dynamicToolRegistry
      .getAllTools()
      .map((tool: { name: string; description?: string }) => {
        const metadata = dynamicToolRegistry.getToolMetadata(tool.name);
        return {
          name: tool.name,
          description: tool.description,
          version: metadata?.version || "unknown",
          source: metadata?.source || "unknown",
        };
      });

    // Get all routers
    const routersStats = dynamicRouterRegistry.getStats();
    const routers = dynamicRouterRegistry.getRouterNames().map((name) => {
      const metadata = dynamicRouterRegistry.getRouterMetadata(name);
      return {
        name,
        version: metadata?.version || "unknown",
        source: metadata?.source || "unknown",
        description: metadata?.description,
      };
    });

    // Get SSE stats
    const sseStats = eventStreamManager.getStats();

    return {
      eventTypes,
      workers, // Expose workers
      tools,
      routers,
      stats: {
        totalEventTypes: eventTypes.length,
        totalHandlers: workers.length,
        totalTools: toolsStats.totalTools,
        totalRouters: routersStats.totalRouters,
        connectedSSEClients: sseStats.totalClients,
        toolsBySource: toolsStats.toolsBySource,
        routersBySource: routersStats.routersBySource,
      },
    };
  }),

  /**
   * Get event type schema
   *
   * Returns the Zod schema for a specific event type, if available.
   * This is used by the admin UI to generate dynamic forms.
   */
  getEventTypeSchema: publicProcedure
    .input(z.object({ eventType: z.string() }))
    .query(async ({ input }) => {
      const schema =
        EventTypeSchemas[input.eventType as keyof typeof EventTypeSchemas];

      if (!schema) {
        return {
          hasSchema: false,
          fields: null,
        };
      }

      // Convert Zod schema to a simplified structure for frontend
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const fields: Array<{
        name: string;
        type: string;
        required: boolean;
        description?: string;
        options?: string[];
        defaultValue?: unknown;
      }> = [];

      for (const [key, value] of Object.entries(shape)) {
        const zodType = value as z.ZodTypeAny;
        let fieldType = "string";
        let required = true;
        let options: string[] | undefined;
        let defaultValue: unknown = undefined;

        // Helper to get inner type
        const getInnerType = (type: z.ZodTypeAny): z.ZodTypeAny => {
          if (type instanceof z.ZodOptional) {
            return type._def.innerType as z.ZodTypeAny;
          }
          if (type instanceof z.ZodDefault) {
            return type._def.innerType as z.ZodTypeAny;
          }
          return type;
        };

        // Check if optional
        const innerType = getInnerType(zodType);
        if (zodType instanceof z.ZodOptional) {
          required = false;
        }

        // Get default value
        if (zodType instanceof z.ZodDefault) {
          try {
            const defValue = (zodType._def as { defaultValue: unknown })
              .defaultValue;
            defaultValue =
              typeof defValue === "function" ? defValue() : defValue;
          } catch {
            // Default function, skip
          }
        }

        // Determine field type
        if (innerType instanceof z.ZodString) {
          fieldType = "string";
        } else if (innerType instanceof z.ZodNumber) {
          fieldType = "number";
        } else if (innerType instanceof z.ZodBoolean) {
          fieldType = "boolean";
        } else if (innerType instanceof z.ZodArray) {
          fieldType = "array";
        } else if (innerType instanceof z.ZodEnum) {
          fieldType = "enum";
          const enumDef = innerType._def as unknown as { values: string[] };
          options = enumDef.values;
        } else if (innerType instanceof z.ZodObject) {
          fieldType = "object";
        } else {
          fieldType = "string"; // Default fallback
        }

        fields.push({
          name: key,
          type: fieldType,
          required,
          options,
          defaultValue,
        });
      }

      return {
        hasSchema: true,
        fields,
      };
    }),

  /**
   * Publish an event to the system
   *
   * This procedure allows manual event publishing for testing and debugging.
   * The event is validated, stored in the event store, and dispatched to pg-boss workers.
   */
  publishEvent: podAdminProcedure
    .input(
      z.object({
        type: z.string().min(1),
        data: z.record(z.string(), z.unknown()),
        userId: z.string().min(1).optional(), // Optional: defaults to authenticated user
        subjectId: z.string().uuid().optional(),
        source: z
          .enum(["api", "automation", "sync", "migration", "system"])
          .optional(),
        correlationId: z.string().uuid().optional(),
        causationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Use authenticated user's ID unless explicitly overridden by pod admin
      const eventUserId = input.userId || ctx.userId;
      // Create the event
      const event = createSynapEvent({
        type: input.type,
        data: input.data,
        userId: eventUserId,
        subjectId: input.subjectId,
        source: input.source || "system",
        correlationId: input.correlationId,
        causationId: input.causationId,
      });

      // Store in event repository (this will also broadcast via SSE hook)
      const storedEvent = await eventRepository.append(event);

      // Dispatch to pg-boss side-effects queue for async processing
      const { getBoss } = await import("@synap/jobs");
      await getBoss().send("side-effects", {
        eventType: input.type,
        ...input.data,
        userId: input.userId,
      });

      return {
        success: true,
        eventId: storedEvent.id,
        timestamp: storedEvent.timestamp.toISOString(),
        message: `Event ${storedEvent.eventType} published successfully`,
      };
    }),

  /**
   * Get recent events (V2 - Enhanced)
   *
   * Returns the most recent events from the event store.
   * Optimized for live event stream with minimal data and filtering.
   */
  getRecentEvents: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        eventType: z.string().optional(),
        userId: z.string().optional(),
        since: z.string().datetime().optional(), // Get events since this time
      })
    )
    .query(async ({ input }) => {
      const events = await eventRepository.searchEvents({
        eventType: input.eventType,
        userId: input.userId,
        fromDate: input.since ? new Date(input.since) : undefined,
        limit: input.limit,
      });

      return {
        events: events.map((event) => ({
          id: event.id,
          type: event.eventType,
          userId: event.userId,
          timestamp: event.timestamp.toISOString(),
          correlationId: event.correlationId,
          isError:
            event.eventType.toLowerCase().includes("error") ||
            event.eventType.toLowerCase().includes("failed"),
        })),
        total: events.length,
        timestamp: new Date().toISOString(),
      };
    }),

  /**
   * Get trace for correlation ID
   *
   * Returns all events that share the same correlation ID.
   * Useful for tracing workflows and debugging event chains.
   */
  getTrace: protectedProcedure
    .input(
      z.object({
        correlationId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const events = await eventRepository.getCorrelatedEvents(
        input.correlationId
      );

      return {
        correlationId: input.correlationId,
        events: events.map((event) => ({
          id: event.id,
          type: event.eventType,
          timestamp: event.timestamp.toISOString(),
          userId: event.userId,
          subjectId: event.subjectId,
          data: event.data,
          metadata: event.metadata,
          causationId: event.causationId,
        })),
        totalEvents: events.length,
      };
    }),

  /**
   * Get event trace by Event ID
   *
   * Finds the event, then fetches all related events with the same correlation ID.
   */
  getEventTrace: protectedProcedure
    .input(z.object({ eventId: z.string().uuid() }))
    .query(async ({ input }) => {
      // 1. Get the main event
      const event = await eventRepository.findById(input.eventId);

      if (!event) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Event ${input.eventId} not found`,
        });
      }

      // 2. Get related events if correlation ID exists
      let relatedEvents: (typeof event)[] = [];
      if (event.correlationId) {
        relatedEvents = await eventRepository.getCorrelatedEvents(
          event.correlationId
        );
        // Exclude the main event from related list
        relatedEvents = relatedEvents.filter((e) => e.id !== event.id);
      }

      return {
        event: {
          eventId: event.id, // Frontend expects eventId
          eventType: event.eventType, // Frontend expects eventType
          timestamp: event.timestamp.toISOString(),
          userId: event.userId,
          data: event.data,
          metadata: event.metadata,
          correlationId: event.correlationId,
        },
        relatedEvents: relatedEvents.map((e) => ({
          eventId: e.id,
          eventType: e.eventType,
          timestamp: e.timestamp.toISOString(),
          userId: e.userId,
          data: e.data,
          correlationId: e.correlationId,
        })),
      };
    }),

  /**
   * Search events with advanced filters
   *
   * Supports filtering by user, event type, aggregate, date range, etc.
   * Useful for the Event Store Advanced Search feature.
   */
  searchEvents: protectedProcedure
    .input(
      z.object({
        userId: z.string().optional(),
        eventType: z.string().optional(),
        subjectType: z.string().optional(),
        subjectId: z.string().optional(),
        correlationId: z.string().optional(),
        fromDate: z.string().datetime().optional(),
        toDate: z.string().datetime().optional(),
        limit: z.number().min(1).max(1000).default(100),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const filters = {
        userId: input.userId,
        eventType: input.eventType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        correlationId: input.correlationId,
        fromDate: input.fromDate ? new Date(input.fromDate) : undefined,
        toDate: input.toDate ? new Date(input.toDate) : undefined,
        limit: input.limit,
        offset: input.offset,
      };

      const events = await eventRepository.searchEvents(filters);
      const totalCount = await eventRepository.countEvents({
        userId: input.userId,
        eventType: input.eventType,
        subjectType: input.subjectType,
        fromDate: filters.fromDate,
        toDate: filters.toDate,
      });

      return {
        events: events.map((event) => ({
          id: event.id,
          type: event.eventType,
          timestamp: event.timestamp.toISOString(),
          userId: event.userId,
          subjectId: event.subjectId,
          subjectType: event.subjectType,
          data: event.data,
          metadata: event.metadata,
          causationId: event.causationId,
          correlationId: event.correlationId,
          source: event.source,
        })),
        pagination: {
          total: totalCount,
          limit: input.limit,
          offset: input.offset,
          hasMore: input.offset + events.length < totalCount,
        },
      };
    }),

  /**
   * Get tool schema for AI Tools Playground
   *
   * Returns the complete schema definition for a specific tool.
   */
  getToolSchema: publicProcedure
    .input(
      z.object({
        toolName: z.string(),
      })
    )
    .query(async ({ input }) => {
      const tool = dynamicToolRegistry.getTool(input.toolName);

      if (!tool) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Tool "${input.toolName}" not found. Available tools: ${dynamicToolRegistry.getToolNames().join(", ")}`,
        });
      }

      const metadata = dynamicToolRegistry.getToolMetadata(input.toolName);

      // Extract schema properties for UI rendering
      const toolSchema = tool.schema as z.ZodTypeAny;
      let schemaProperties: Record<string, z.ZodTypeAny> = {};
      if (toolSchema instanceof z.ZodObject) {
        schemaProperties = (toolSchema as z.ZodObject<z.ZodRawShape>)
          .shape as Record<string, z.ZodTypeAny>;
      }

      return {
        name: tool.name,
        description: tool.description,
        schema: {
          type: "object",
          properties: schemaProperties,
          required: Object.keys(schemaProperties),
        },
        metadata: {
          version: metadata?.version || "unknown",
          source: metadata?.source || "unknown",
          registeredAt: metadata?.registeredAt.toISOString(),
        },
      };
    }),

  /**
   * Execute tool for AI Tools Playground
   *
   * Allows testing tools in isolation without running the full AI agent.
   */
  executeTool: podAdminProcedure
    .input(
      z.object({
        toolName: z.string(),
        parameters: z.record(z.string(), z.unknown()),
        threadId: z.string().default("playground"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const tool = dynamicToolRegistry.getTool(input.toolName);

      if (!tool) {
        throw new Error(`Tool "${input.toolName}" not found`);
      }

      // Execute the tool with the authenticated user's ID
      const result = await tool.execute(input.parameters, {
        userId: ctx.userId,
        threadId: input.threadId,
      });

      return {
        success: true,
        result: result,
        toolName: input.toolName,
        executedAt: new Date().toISOString(),
      };
    }),

  /**
   * Get Dashboard Metrics (V2)
   *
   * Returns aggregated real-time metrics optimized for the Dashboard view.
   * Includes health status, throughput, latency, and key system statistics.
   */
  getDashboardMetrics: protectedProcedure.query(async () => {
    // Get recent events for rate calculation (last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentEvents = await eventRepository.searchEvents({
      fromDate: fiveMinutesAgo,
      limit: 1000,
    });

    // Calculate events per second (last 5 min average)
    const timeWindowSeconds = 5 * 60;
    const eventsPerSecond = recentEvents.length / timeWindowSeconds;

    // Get latest events for live stream
    const latestEvents = await eventRepository.searchEvents({
      limit: 20,
    });

    // Calculate error rate (events with 'error' in type)
    const errorEvents = recentEvents.filter(
      (e) =>
        e.eventType.toLowerCase().includes("error") ||
        e.eventType.toLowerCase().includes("failed")
    );
    const errorRate =
      recentEvents.length > 0
        ? (errorEvents.length / recentEvents.length) * 100
        : 0;

    // Get system stats
    const sseStats = eventStreamManager.getStats();
    const toolsStats = dynamicToolRegistry.getStats();
    // Phase 4: Handlers are independent, no registry count available
    const handlersStats = 0;

    // Determine overall health status
    let healthStatus: "healthy" | "degraded" | "critical";
    if (errorRate > 10) {
      healthStatus = "critical";
    } else if (errorRate > 5 || eventsPerSecond > 100) {
      healthStatus = "degraded";
    } else {
      healthStatus = "healthy";
    }

    return {
      timestamp: new Date().toISOString(),
      health: {
        status: healthStatus,
        errorRate: Math.round(errorRate * 10) / 10, // Round to 1 decimal
      },
      throughput: {
        eventsPerSecond: Math.round(eventsPerSecond * 100) / 100, // Round to 2 decimals
        totalEventsLast5Min: recentEvents.length,
      },
      connections: {
        activeSSEClients: sseStats.totalClients,
        activeHandlers: handlersStats,
      },
      tools: {
        totalTools: toolsStats.totalTools,
        totalExecutions: 0, // TODO: Track tool executions
      },
      latestEvents: latestEvents.map((event) => ({
        id: event.id,
        type: event.eventType,
        userId: event.userId,
        timestamp: event.timestamp.toISOString(),
        isError:
          event.eventType.toLowerCase().includes("error") ||
          event.eventType.toLowerCase().includes("failed"),
      })),
    };
  }),

  /**
   * Get database tables
   *
   * Returns a list of all tables in the public schema with their row counts.
   */
  getDatabaseTables: podAdminProcedure.query(async () => {
    const tables = await db.execute(sqlDrizzle`
        SELECT
          table_name as name,
          (SELECT count(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count,
          (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = t.table_name) as estimated_rows
        FROM information_schema.tables t
        WHERE table_schema = 'public'
        ORDER BY table_name;
      `);
    console.log(`[SystemRouter] Found ${tables.length} tables`);
    return [...tables] as unknown[];
  }),

  /**
   * Get database table rows
   *
   * Returns raw data from a specific table with pagination.
   */
  getDatabaseTableRows: podAdminProcedure
    .input(
      z.object({
        tableName: z.string(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      // Validate table name to prevent SQL injection (whitelisting)
      const validTables = await db.execute(sqlDrizzle`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `);

      const isValid = validTables.some(
        (t: Record<string, unknown>) => t.table_name === input.tableName
      );
      if (!isValid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid table name: ${input.tableName}`,
        });
      }

      // Safe query using sql.raw is risky if input is not validated, but we validated it against the schema above.
      // However, parameters cannot be used for identifiers.
      // Since we validated input.tableName exists in information_schema, it is safe to interpolate.
      const query = sqlDrizzle.raw(
        `SELECT * FROM "${input.tableName}" LIMIT ${input.limit} OFFSET ${input.offset}`
      );
      const rows = await db.execute(query);
      return rows as unknown[];
    }),

  /**
   * Get service health status
   *
   * Checks the connectivity and health of all dependent services:
   * - Postgres (Database)
   * - Typesense (Search)
   * - MinIO (Storage)
   * - Hydra (OAuth Provider)
   * - Kratos (Identity Provider)
   */
  getServiceHealth: protectedProcedure.query(async () => {
    const services: Array<{
      name: string;
      status: "healthy" | "unhealthy" | "degraded";
      message?: string;
      latency?: number;
    }> = [];

    // 1. Postgres Check
    try {
      const start = Date.now();
      await db.execute(sqlDrizzle`SELECT 1`);
      services.push({
        name: "Postgres",
        status: "healthy",
        latency: Date.now() - start,
      });
    } catch (e) {
      services.push({
        name: "Postgres",
        status: "unhealthy",
        message: String(e),
      });
    }

    // 2. Typesense Check
    try {
      const start = Date.now();
      const isConnected = await testConnection();
      if (!isConnected) throw new Error("Connection failed");
      services.push({
        name: "Typesense",
        status: "healthy",
        latency: Date.now() - start,
      });
    } catch (e) {
      services.push({
        name: "Typesense",
        status: "unhealthy",
        message: String(e),
      });
    }

    // 3. MinIO Check
    try {
      const start = Date.now();
      const endpoint = process.env.MINIO_ENDPOINT || "http://minio:9000";
      // We check minio/health/live
      const res = await fetch(`${endpoint}/minio/health/live`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      services.push({
        name: "MinIO",
        status: "healthy",
        latency: Date.now() - start,
      });
    } catch (e) {
      services.push({
        name: "MinIO",
        status: "unhealthy",
        message: String(e),
      });
    }

    // 4. Hydra Check
    try {
      const start = Date.now();
      const endpoint = process.env.HYDRA_ADMIN_URL || "http://hydra:4445";
      const res = await fetch(`${endpoint}/health/ready`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      services.push({
        name: "Hydra",
        status: "healthy",
        latency: Date.now() - start,
      });
    } catch (e) {
      services.push({
        name: "Hydra",
        status: "unhealthy",
        message: String(e),
      });
    }

    // 5. Kratos Check
    try {
      const start = Date.now();
      const endpoint = process.env.KRATOS_ADMIN_URL || "http://kratos:4434";
      const res = await fetch(`${endpoint}/health/ready`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      services.push({
        name: "Kratos",
        status: "healthy",
        latency: Date.now() - start,
      });
    } catch (e) {
      services.push({
        name: "Kratos",
        status: "unhealthy",
        message: String(e),
      });
    }

    return services;
  }),

  /**
   * Get Data Pod Stats
   *
   * Returns global counts for the Data Pod overview dashboard.
   * Requires authentication.
   */
  getDataPodStats: protectedProcedure.query(async () => {
    const [userResult] = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.userType, "human"));
    const [agentResult] = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.userType, "agent"));
    const [workspaceResult] = await db
      .select({ value: count() })
      .from(workspaces);
    const [entityResult] = await db.select({ value: count() }).from(entities);
    const [documentResult] = await db
      .select({ value: count() })
      .from(documents);

    return {
      userCount: userResult?.value ?? 0,
      agentCount: agentResult?.value ?? 0,
      workspaceCount: workspaceResult?.value ?? 0,
      entityCount: entityResult?.value ?? 0,
      documentCount: documentResult?.value ?? 0,
    };
  }),

  /**
   * List all users across the pod
   *
   * Admin-level query returning all users with optional type filter and pagination.
   * Includes workspace membership count for each user.
   */
  listUsers: protectedProcedure
    .input(
      z.object({
        type: z.enum(["all", "human", "agent"]).default("all"),
        limit: z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      // Build query with optional type filter
      const conditions =
        input.type !== "all" ? eq(users.userType, input.type) : undefined;

      const userList = await db.query.users.findMany({
        where: conditions,
        limit: input.limit,
        offset: input.offset,
        orderBy: (users, { desc }) => [desc(users.createdAt)],
      });

      // Get membership counts for each user
      const usersWithMemberships = await Promise.all(
        userList.map(async (user) => {
          const [membershipCount] = await db
            .select({ value: count() })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.userId, user.id));

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            userType: user.userType,
            agentMetadata: user.agentMetadata,
            createdAt: user.createdAt?.toISOString() ?? null,
            workspaceMembershipCount: membershipCount?.value ?? 0,
          };
        })
      );

      // Get total count for pagination
      const [totalResult] = await db
        .select({ value: count() })
        .from(users)
        .where(conditions);

      return {
        users: usersWithMemberships,
        pagination: {
          total: totalResult?.value ?? 0,
          limit: input.limit,
          offset: input.offset,
          hasMore: input.offset + userList.length < (totalResult?.value ?? 0),
        },
      };
    }),

  /**
   * Get CORS settings for this pod.
   *
   * Returns the env-var origins (read-only) and the DB-stored origins (editable).
   * Pod admin only.
   */
  getCorsSettings: podAdminProcedure.query(async () => {
    // Find the pod's first workspace (same logic as podAdminProcedure)
    const ws = await db.query.workspaces.findFirst({
      orderBy: (ws, { asc }) => [asc(ws.createdAt)],
    });

    const envOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
          .map((o) => o.trim())
          .filter(Boolean)
      : [];

    const settingsRecord = ws?.settings as Record<string, unknown> | null;
    const dbOrigins: string[] =
      (settingsRecord?.corsAllowedOrigins as string[]) ?? [];

    return {
      envOrigins, // from ALLOWED_ORIGINS env var (read-only)
      dbOrigins, // from workspace settings (editable)
      merged: [...new Set([...envOrigins, ...dbOrigins])],
    };
  }),

  /**
   * Update the DB-stored CORS allowed origins for this pod.
   *
   * Immediately updates the in-memory cache so changes take effect without restart.
   * Pod admin only.
   */
  updateCorsSettings: podAdminProcedure
    .input(
      z.object({
        origins: z
          .array(
            z
              .string()
              .url("Each origin must be a valid URL (no trailing slash)")
          )
          .max(50, "Maximum 50 allowed origins"),
      })
    )
    .mutation(async ({ input }) => {
      const ws = await db.query.workspaces.findFirst({
        orderBy: (ws, { asc }) => [asc(ws.createdAt)],
      });

      if (!ws) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No workspace found on this pod",
        });
      }

      await db
        .update(workspaces)
        .set({
          settings: sqlDrizzle`settings || ${JSON.stringify({ corsAllowedOrigins: input.origins })}::jsonb`,
        })
        .where(eq(workspaces.id, ws.id));

      // Update in-memory cache immediately (no restart required)
      const envOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : [];
      setDynamicCorsOrigins([...new Set([...envOrigins, ...input.origins])]);

      return { origins: input.origins, merged: getDynamicCorsOrigins() };
    }),
});
