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
import { getAllEventTypes, getBoss, getEventCatalog } from "@synap/events";
import { getAllGeneratedEventTypes, parseEventType } from "@synap/events";
import { testConnection } from "@synap/search";
import { dynamicToolRegistry } from "@synap/ai";
import { dynamicRouterRegistry } from "../router-registry.js";
import { createSynapEvent } from "@synap-core/core";
import { eventRepository } from "@synap/database";
import { eventStreamManager } from "../event-stream-manager.js";
import { db, eq, and, sqlDrizzle } from "@synap/database";
import {
  users,
  workspaces,
  entities,
  documents,
  workspaceMembers,
  apiKeys,
  podSettings,
} from "@synap/database/schema";
import { count, inArray } from "@synap/database";
import crypto from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import {
  getDynamicCorsOrigins,
  setDynamicCorsOrigins,
} from "../utils/cors-cache.js";
import { getTrustedIssuerSeedHealth } from "../utils/startup-health.js";
import { kratosAdmin } from "@synap/auth";

const execAsync = promisify(execCb);

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
        events: events.map((event) => {
          // `{subject}.{action}.{phase}` — surface the subject + phase so the
          // client can PACKAGE a lifecycle (requested→validated→completed) for
          // the SAME subject into one card instead of three loose rows.
          const parts = event.eventType.split(".");
          const phase = parts.length >= 3 ? parts[parts.length - 1] : null;
          return {
            id: event.id,
            type: event.eventType,
            userId: event.userId,
            timestamp: event.timestamp.toISOString(),
            correlationId: event.correlationId,
            // subject = the thing the event is about; used to group a lifecycle.
            // actor fields resolve the "Someone" label on event cards.
            subjectId: event.subjectId ?? null,
            subjectType: event.subjectType ?? null,
            phase,
            isAgent: event.isAgent ?? false,
            agentUserId: event.agentUserId ?? null,
            isError:
              event.eventType.toLowerCase().includes("error") ||
              event.eventType.toLowerCase().includes("failed"),
          };
        }),
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
    .query(async ({ ctx, input }) => {
      // User-scope the correlation lookup: correlation_id is not unique per
      // user, so an unscoped query would leak other tenants' events.
      const events = await eventRepository.getCorrelatedEvents(
        input.correlationId,
        ctx.userId
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
        // Scope correlated events to the source event's owner so the trace
        // stays consistent and never leaks another tenant's events.
        relatedEvents = await eventRepository.getCorrelatedEvents(
          event.correlationId,
          event.userId
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
        workspaceId: z.string().optional(),
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
        workspaceId: input.workspaceId,
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
        workspaceId: input.workspaceId,
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

    // 6. Trusted issuers startup seed check
    const issuerSeed = getTrustedIssuerSeedHealth();
    services.push({
      name: "TrustedIssuersSeed",
      status: issuerSeed.ok ? "healthy" : "degraded",
      message: issuerSeed.ok
        ? `checkedAt=${issuerSeed.checkedAt}`
        : `checkedAt=${issuerSeed.checkedAt}, error=${issuerSeed.error ?? "unknown"}`,
    });

    return services;
  }),

  /**
   * Pod runtime config snapshot (sanitized) for admin diagnostics.
   */
  getPodRuntimeConfig: podAdminProcedure.query(async () => {
    const envKeys = [
      "DOMAIN",
      "OPENCLAW_DOMAIN",
      "PUBLIC_URL",
      "INTELLIGENCE_HUB_URL",
      "CONTROL_PLANE_URL",
      "ALLOWED_ORIGINS",
      "EMBEDDING_PROVIDER",
      "NODE_ENV",
    ] as const;

    const env = envKeys.map((key) => ({
      key,
      value: process.env[key] ?? null,
    }));

    const deployCandidates = [
      "/opt/synap/deploy",
      process.cwd(),
      `${process.cwd()}/deploy`,
    ];

    const caddy = await readFirstAvailableFile(
      deployCandidates.map((dir) => `${dir}/Caddyfile`)
    );
    const openclawAuthSnippet = await readFirstAvailableFile(
      deployCandidates.map((dir) => `${dir}/openclaw_auth.snippet`)
    );

    return {
      env,
      files: {
        caddyfile: caddy,
        openclawAuthSnippet,
      },
      notes: {
        fileAccess:
          "If file content is unavailable, the API container likely cannot read host deploy files in this environment.",
      },
    };
  }),

  /**
   * Fetch service logs via docker compose (best effort).
   */
  getServiceLogs: podAdminProcedure
    .input(
      z.object({
        service: z.string().regex(/^[a-z0-9-_]+$/i),
        tail: z.number().min(20).max(1000).default(200),
      })
    )
    .query(async ({ input }) => {
      const composeFiles = [
        "/opt/synap/deploy/docker-compose.yml",
        `${process.cwd()}/docker-compose.yml`,
        `${process.cwd()}/deploy/docker-compose.yml`,
      ];

      const composeFile =
        (await firstExistingFile(composeFiles)) ?? "docker-compose.yml";

      const cmd = `docker compose -f "${composeFile}" logs --tail=${input.tail} "${input.service}"`;
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          timeout: 15_000,
          maxBuffer: 1024 * 1024 * 8,
        });
        const text = [stdout, stderr].filter(Boolean).join("\n").trim();
        return {
          service: input.service,
          tail: input.tail,
          logs: text || "No logs returned.",
          command: cmd,
        };
      } catch (error) {
        return {
          service: input.service,
          tail: input.tail,
          logs: "",
          command: cmd,
          error:
            error instanceof Error
              ? error.message
              : "Unable to fetch logs in this runtime environment.",
        };
      }
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
   * Reset password for one user or all human users.
   *
   * Pod admin only. Returns generated temporary password(s) that can be shared
   * through a secure channel.
   */
  resetUserPassword: podAdminProcedure
    .input(
      z.object({
        mode: z.enum(["single", "all_humans"]).default("single"),
        userId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const targets =
        input.mode === "all_humans"
          ? await db.query.users.findMany({
              where: eq(users.userType, "human"),
              columns: { id: true, email: true, name: true },
            })
          : input.userId
            ? await db.query.users.findMany({
                where: eq(users.id, input.userId),
                columns: { id: true, email: true, name: true },
              })
            : [];

      if (targets.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            input.mode === "all_humans"
              ? "No human users found"
              : "User not found",
        });
      }

      const results: Array<{
        userId: string;
        email: string;
        tempPassword: string;
      }> = [];
      const failures: Array<{ userId: string; email: string; error: string }> =
        [];

      for (const target of targets) {
        const tempPassword = crypto.randomBytes(12).toString("base64url");
        try {
          const identity = await kratosAdmin.getIdentity({ id: target.id });
          await kratosAdmin.updateIdentity({
            id: target.id,
            updateIdentityBody: {
              schema_id: identity.data.schema_id,
              state: (identity.data.state ?? "active") as never,
              traits: identity.data.traits ?? { email: target.email },
              credentials: {
                password: { config: { password: tempPassword } },
              },
            },
          });
          results.push({
            userId: target.id,
            email: target.email,
            tempPassword,
          });
        } catch (error: unknown) {
          failures.push({
            userId: target.id,
            email: target.email,
            error:
              error instanceof Error ? error.message : "Kratos update failed",
          });
        }
      }

      if (results.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Password reset failed for all target users (${failures.length} failure(s))`,
        });
      }

      return {
        mode: input.mode,
        resetCount: results.length,
        failedCount: failures.length,
        results,
        failures,
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

  // ─────────────────────────────────────────────────────────────────────
  // Job queue (pg-boss) — operational visibility for pod admins.
  //
  // pg-boss exposes JS APIs for retry/cancel/getJobById, but no list-all.
  // We read pgboss.job directly for listing and aggregate stats. State
  // changes still go through the JS API so pg-boss invariants hold.
  // ─────────────────────────────────────────────────────────────────────

  /** Aggregate counts per state and per queue. */
  getQueueStats: podAdminProcedure.query(async () => {
    const totals = (await db.execute(sqlDrizzle`
      SELECT state, count(*)::int AS count
      FROM pgboss.job
      GROUP BY state
    `)) as unknown as Array<{ state: string; count: number }>;

    const perQueue = (await db.execute(sqlDrizzle`
      SELECT name AS queue, state, count(*)::int AS count
      FROM pgboss.job
      GROUP BY name, state
      ORDER BY name
    `)) as unknown as Array<{ queue: string; state: string; count: number }>;

    const states = [
      "created",
      "retry",
      "active",
      "completed",
      "cancelled",
      "failed",
    ] as const;

    const totalsByState: Record<string, number> = Object.fromEntries(
      states.map((s) => [s, 0])
    );
    for (const row of totals) {
      totalsByState[row.state] = row.count;
    }

    const queueMap = new Map<string, Record<string, number>>();
    for (const row of perQueue) {
      const existing =
        queueMap.get(row.queue) ??
        Object.fromEntries(states.map((s) => [s, 0]));
      existing[row.state] = row.count;
      queueMap.set(row.queue, existing);
    }

    return {
      totals: totalsByState,
      queues: Array.from(queueMap.entries()).map(([queue, counts]) => ({
        queue,
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      })),
    };
  }),

  /** Recent jobs, optionally filtered by state and/or queue name. */
  listJobs: podAdminProcedure
    .input(
      z.object({
        state: z
          .enum([
            "created",
            "retry",
            "active",
            "completed",
            "cancelled",
            "failed",
          ])
          .optional(),
        queueName: z.string().optional(),
        limit: z.number().min(1).max(200).default(50),
      })
    )
    .query(async ({ input }) => {
      // Build a parameterized WHERE clause via drizzle's sql composition.
      const conditions: ReturnType<typeof sqlDrizzle>[] = [];
      if (input.state) {
        conditions.push(sqlDrizzle`state = ${input.state}`);
      }
      if (input.queueName) {
        conditions.push(sqlDrizzle`name = ${input.queueName}`);
      }

      const whereClause =
        conditions.length === 0
          ? sqlDrizzle.empty()
          : sqlDrizzle`WHERE ${sqlDrizzle.join(conditions, sqlDrizzle` AND `)}`;

      const rows = (await db.execute(sqlDrizzle`
        SELECT
          id::text AS id,
          name AS queue,
          state,
          retry_count AS "retryCount",
          retry_limit AS "retryLimit",
          created_on AS "createdOn",
          started_on AS "startedOn",
          completed_on AS "completedOn",
          (CASE
            WHEN length(data::text) > 500
              THEN left(data::text, 500) || '…'
            ELSE data::text
           END) AS "dataPreview",
          (CASE
            WHEN output IS NULL THEN NULL
            WHEN length(output::text) > 500
              THEN left(output::text, 500) || '…'
            ELSE output::text
           END) AS "outputPreview"
        FROM pgboss.job
        ${whereClause}
        ORDER BY created_on DESC
        LIMIT ${input.limit}
      `)) as unknown as Array<{
        id: string;
        queue: string;
        state: string;
        retryCount: number;
        retryLimit: number;
        createdOn: Date;
        startedOn: Date | null;
        completedOn: Date | null;
        dataPreview: string | null;
        outputPreview: string | null;
      }>;

      return rows;
    }),

  /** Full job row including untruncated data + output. */
  getJobDetails: podAdminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const rows = (await db.execute(sqlDrizzle`
        SELECT
          id::text AS id,
          name AS queue,
          state,
          priority,
          retry_count AS "retryCount",
          retry_limit AS "retryLimit",
          retry_delay AS "retryDelay",
          retry_backoff AS "retryBackoff",
          created_on AS "createdOn",
          start_after AS "startAfter",
          started_on AS "startedOn",
          completed_on AS "completedOn",
          keep_until AS "keepUntil",
          singleton_key AS "singletonKey",
          dead_letter AS "deadLetter",
          policy,
          data,
          output
        FROM pgboss.job
        WHERE id = ${input.id}::uuid
        LIMIT 1
      `)) as unknown as Array<Record<string, unknown>>;

      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
      }
      return rows[0];
    }),

  /** Re-enqueue a failed/cancelled job via pg-boss API. */
  retryJob: podAdminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const rows = (await db.execute(sqlDrizzle`
        SELECT name FROM pgboss.job WHERE id = ${input.id}::uuid LIMIT 1
      `)) as unknown as Array<{ name: string }>;
      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
      }
      try {
        await getBoss().retry(rows[0].name, input.id);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Retry failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return { ok: true };
    }),

  /** Cancel an active/queued job via pg-boss API. */
  cancelJob: podAdminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const rows = (await db.execute(sqlDrizzle`
        SELECT name FROM pgboss.job WHERE id = ${input.id}::uuid LIMIT 1
      `)) as unknown as Array<{ name: string }>;
      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
      }
      try {
        await getBoss().cancel(rows[0].name, input.id);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return { ok: true };
    }),

  // ─────────────────────────────────────────────────────────────────────
  // Audit log — curated lens on the events table for governance/security.
  //
  // Distinct from searchEvents (raw debugging tool). This endpoint filters
  // to a fixed set of audit-relevant subject types and resolves user names
  // in a single batch so the UI can render readable rows.
  // ─────────────────────────────────────────────────────────────────────
  listAuditLogs: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.string().nullable().optional(),
        userId: z.string().nullable().optional(),
        subjectType: z.string().nullable().optional(),
        // Accept both singular and plural for backward compat with older clients.
        action: z.string().nullable().optional(),
        actions: z.array(z.string()).optional(),
        fromDate: z.string().datetime().optional(),
        toDate: z.string().datetime().optional(),
        limit: z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const AUDIT_SUBJECT_TYPES = [
        "entity",
        "document",
        "relation",
        "capture",
        "command",
        "connector",
        "notification",
        "external_message",
        "external_channel",
        "messaging_account",
        "feed_item",
        "inbox_item",
        "backgroundTask",
        "workspaces",
        "workspace_members",
        "api_keys",
        "proposals",
        "agents",
        "users",
        "secrets",
        "intelligence_services",
        "trusted_issuers",
      ];

      // Merge singular action → actions array; coerce null → undefined.
      const actions =
        input.actions ?? (input.action ? [input.action] : undefined);

      const events = await eventRepository.searchEvents({
        userId: input.userId ?? undefined,
        subjectType: input.subjectType ?? undefined,
        subjectTypes: input.subjectType ? undefined : AUDIT_SUBJECT_TYPES,
        actions,
        workspaceId: input.workspaceId ?? undefined,
        fromDate: input.fromDate ? new Date(input.fromDate) : undefined,
        toDate: input.toDate ? new Date(input.toDate) : undefined,
        limit: input.limit,
        offset: input.offset,
      });

      // Restrict to phase=completed so we surface only successful audit events.
      // Action filtering is now handled by searchEvents on the backend.
      const filtered = events.filter((ev) => {
        const parts = ev.eventType.split(".");
        const phase = parts[parts.length - 1];
        return phase === "completed";
      });

      // Batch-resolve actor user info so the UI can show readable names.
      const uniqueUserIds = Array.from(new Set(filtered.map((e) => e.userId)));
      const actorMap: Record<
        string,
        { id: string; email: string | null; name: string | null }
      > = {};
      if (uniqueUserIds.length > 0) {
        const rows = await db.query.users.findMany({
          where: (u, { inArray }) => inArray(u.id, uniqueUserIds),
          columns: { id: true, email: true, name: true },
        });
        for (const u of rows) {
          actorMap[u.id] = {
            id: u.id,
            email: u.email ?? null,
            name: u.name ?? null,
          };
        }
      }

      // Resolve workspace names for the optional "workspace" column.
      const uniqueWorkspaceIds = Array.from(
        new Set(
          filtered
            .map((e) => (e.data as Record<string, unknown>)?.workspaceId)
            .filter((v): v is string => typeof v === "string" && v.length > 0)
        )
      );
      const workspaceMap: Record<string, { id: string; name: string }> = {};
      if (uniqueWorkspaceIds.length > 0) {
        const rows = await db.query.workspaces.findMany({
          where: (w, { inArray }) => inArray(w.id, uniqueWorkspaceIds),
          columns: { id: true, name: true },
        });
        for (const w of rows) {
          workspaceMap[w.id] = { id: w.id, name: w.name };
        }
      }

      return {
        events: filtered.map((ev) => {
          const parts = ev.eventType.split(".");
          const wsId = (ev.data as Record<string, unknown>)?.workspaceId;
          return {
            id: ev.id,
            timestamp: ev.timestamp,
            eventType: ev.eventType,
            action: parts[1] ?? "",
            phase: parts[parts.length - 1] ?? "",
            subjectType: ev.subjectType,
            subjectId: ev.subjectId,
            userId: ev.userId,
            workspaceId: typeof wsId === "string" ? wsId : null,
            source: ev.source,
            correlationId: ev.correlationId ?? null,
            data: ev.data,
            metadata: ev.metadata,
          };
        }),
        actors: actorMap,
        workspaces: workspaceMap,
        availableSubjectTypes: AUDIT_SUBJECT_TYPES,
      };
    }),

  listEventCatalog: protectedProcedure.query(() => {
    return getEventCatalog();
  }),

  /**
   * Hard-delete a user and cascade their pod-side artifacts.
   *
   * Cascades:
   *   - workspace memberships
   *   - agent users created by the target (users with
   *     agentMetadata.createdByUserId === target.id; users.user_type='agent')
   *   - api keys owned by the target
   *
   * Safety rails:
   *   - Cannot delete yourself (FORBIDDEN).
   *   - Cannot delete the last remaining pod admin (BAD_REQUEST).
   *   - Pod-admin only.
   */
  deleteUser: podAdminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.userId === input.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot delete your own account.",
        });
      }

      // Confirm the target exists.
      const target = await db.query.users.findFirst({
        where: eq(users.id, input.userId),
        columns: { id: true, userType: true },
      });
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      // Last-pod-admin guard. We only run this check when the target is
      // currently a pod admin themselves — deleting a non-admin can never
      // affect the admin headcount.
      const podAdminWorkspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.systemSlug, "pod-admin"),
        columns: { id: true },
      });

      if (podAdminWorkspace) {
        const targetIsPodAdmin = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
            eq(workspaceMembers.userId, input.userId),
            inArray(workspaceMembers.role, ["admin", "owner"])
          ),
          columns: { id: true },
        });

        if (targetIsPodAdmin) {
          const remainingAdmins = await db
            .select({ value: count() })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
                inArray(workspaceMembers.role, ["admin", "owner"])
              )
            );
          const remaining = (remainingAdmins[0]?.value ?? 0) - 1;
          if (remaining <= 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Cannot delete the last pod admin. Promote another user to admin first.",
            });
          }
        }
      }

      // All cascades + the user delete in one transaction so a partial failure
      // doesn't leave orphaned rows pointing at a deleted user id.
      await db.transaction(async (tx) => {
        // 1. Workspace memberships owned by the target.
        await tx
          .delete(workspaceMembers)
          .where(eq(workspaceMembers.userId, input.userId));

        // 2. Agent users this human spawned. Identified via
        //    users.agent_metadata->>'createdByUserId' = <target.id>. Their
        //    own memberships and api keys are cleaned up alongside.
        const childAgents = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.userType, "agent"),
              eq(users.createdByUserId, input.userId)
            )
          );
        const childAgentIds = childAgents.map((row) => row.id);
        if (childAgentIds.length > 0) {
          await tx
            .delete(workspaceMembers)
            .where(inArray(workspaceMembers.userId, childAgentIds));
          await tx
            .delete(apiKeys)
            .where(inArray(apiKeys.userId, childAgentIds));
          await tx.delete(users).where(inArray(users.id, childAgentIds));
        }

        // 3. API keys owned directly by the target.
        await tx.delete(apiKeys).where(eq(apiKeys.userId, input.userId));

        // 4. The user row itself.
        await tx.delete(users).where(eq(users.id, input.userId));
      });

      return {
        success: true as const,
        deletedUserId: input.userId,
      };
    }),

  /**
   * Backup status for the pod admin dashboard.
   *
   * Reads from `pod_settings.settings.backup` (singleton row). When no backup
   * job has ever run / no row exists, returns a `never` stub so the UI can
   * render the section without crashing. The actual backup runner does not
   * exist yet; once it lands it should write a `backup` blob into pod_settings
   * matching the shape returned here.
   *
   * TODO: wire to actual backup job once implemented.
   */
  getBackupStatus: podAdminProcedure.query(async () => {
    const [row] = await db
      .select({ settings: podSettings.settings })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);

    const blob = (row?.settings ?? {}) as Record<string, unknown>;
    const backup = (blob.backup ?? null) as {
      lastBackupAt?: string | null;
      status?: "ok" | "stale" | "never" | "error";
      sizeBytes?: number | null;
      location?: string | null;
    } | null;

    if (!backup) {
      return {
        lastBackupAt: null as Date | null,
        status: "never" as const,
        sizeBytes: null as number | null,
        location: null as string | null,
      };
    }

    return {
      lastBackupAt: backup.lastBackupAt ? new Date(backup.lastBackupAt) : null,
      status: (backup.status ?? "never") as "ok" | "stale" | "never" | "error",
      sizeBytes: backup.sizeBytes ?? null,
      location: backup.location ?? null,
    };
  }),
});

async function firstExistingFile(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

async function readFirstAvailableFile(paths: string[]) {
  const file = await firstExistingFile(paths);
  if (!file) {
    return { path: null, content: null };
  }
  try {
    const content = await readFile(file, "utf-8");
    return { path: file, content };
  } catch {
    return { path: file, content: null };
  }
}
