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

import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';
import { getAllEventTypes, EventTypeSchemas } from '@synap/types';
import { handlerRegistry, inngest } from '@synap/jobs';
// NOTE: @synap/ai has been moved to synap-intelligence-hub (proprietary)
// Tools are now managed by Intelligence Hub
// import { dynamicToolRegistry } from '@synap/ai';
import { dynamicRouterRegistry } from '../router-registry.js';
import { createSynapEvent } from '@synap/types';
import { eventRepository } from '@synap/database';
import { eventStreamManager } from '../event-stream-manager.js';

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
    // Get all event types
    const eventTypes = getAllEventTypes().map(type => ({
      type,
      hasSchema: type in EventTypeSchemas,
    }));

    // Get all event handlers
    const handlerEventTypes = handlerRegistry.getRegisteredEventTypes();
    const handlers = handlerEventTypes.map((eventType: string) => {
      const handlersForType = handlerRegistry.getHandlers(eventType);
      return {
        eventType,
        handlers: handlersForType.map((handler: { eventType: string; handle: unknown }) => ({
          name: handler.constructor.name,
          eventType: handler.eventType,
        })),
      };
    });

    // Get all tools
    // NOTE: Tools are now managed by Intelligence Hub (proprietary)
    // Tools are no longer available in the open-source Data Pod
    const tools: Array<{ name: string; description?: string; version: string; source: string }> = [];
    /*
    const toolsStats = dynamicToolRegistry.getStats();
    const tools = dynamicToolRegistry.getAllTools().map((tool: { name: string; description?: string }) => {
      const metadata = dynamicToolRegistry.getToolMetadata(tool.name);
      return {
        name: tool.name,
        description: tool.description,
        version: metadata?.version || 'unknown',
        source: metadata?.source || 'unknown',
      };
    });
    */

    // Get all routers
    const routersStats = dynamicRouterRegistry.getStats();
    const routers = dynamicRouterRegistry.getRouterNames().map(name => {
      const metadata = dynamicRouterRegistry.getRouterMetadata(name);
      return {
        name,
        version: metadata?.version || 'unknown',
        source: metadata?.source || 'unknown',
        description: metadata?.description,
      };
    });

    // Get SSE stats
    const sseStats = eventStreamManager.getStats();

    return {
      eventTypes,
      handlers,
      tools,
      routers,
      stats: {
        totalEventTypes: eventTypes.length,
        totalHandlers: handlers.reduce((acc: number, h: { handlers: unknown[] }) => acc + h.handlers.length, 0),
        totalTools: 0, // Tools are now in Intelligence Hub
        totalRouters: routersStats.totalRouters,
        connectedSSEClients: sseStats.totalClients,
        toolsBySource: {}, // Tools are now in Intelligence Hub
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
      const schema = EventTypeSchemas[input.eventType as keyof typeof EventTypeSchemas];
      
      if (!schema) {
        return {
          hasSchema: false,
          fields: null,
        };
      }

      // Convert Zod schema to a simplified structure for frontend
      const shape = (schema as z.ZodObject<any>)._def.shape();
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
        let fieldType = 'string';
        let required = true;
        let options: string[] | undefined;
        let defaultValue: unknown = undefined;

        // Helper to get inner type
        const getInnerType = (type: z.ZodTypeAny): z.ZodTypeAny => {
          if (type instanceof z.ZodOptional) {
            return type._def.innerType;
          }
          if (type instanceof z.ZodDefault) {
            return type._def.innerType;
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
            defaultValue = zodType._def.defaultValue();
          } catch {
            // Default function, skip
          }
        }

        // Determine field type
        if (innerType instanceof z.ZodString) {
          fieldType = 'string';
        } else if (innerType instanceof z.ZodNumber) {
          fieldType = 'number';
        } else if (innerType instanceof z.ZodBoolean) {
          fieldType = 'boolean';
        } else if (innerType instanceof z.ZodArray) {
          fieldType = 'array';
        } else if (innerType instanceof z.ZodEnum) {
          fieldType = 'enum';
          options = innerType._def.values;
        } else if (innerType instanceof z.ZodObject) {
          fieldType = 'object';
        } else {
          fieldType = 'string'; // Default fallback
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
   * The event is validated, stored in the event store, and broadcast to Inngest workers.
   */
  publishEvent: publicProcedure
    .input(
      z.object({
        type: z.string().min(1),
        data: z.record(z.unknown()),
        userId: z.string().min(1),
        aggregateId: z.string().uuid().optional(),
        source: z.enum(['api', 'automation', 'sync', 'migration', 'system']).optional(),
        correlationId: z.string().uuid().optional(),
        causationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Create the event
      const event = createSynapEvent({
        type: input.type as any,
        data: input.data,
        userId: input.userId,
        aggregateId: input.aggregateId,
        source: input.source || 'system',
        correlationId: input.correlationId,
        causationId: input.causationId,
      });

      // Store in event repository (this will also broadcast via SSE hook)
      const storedEvent = await eventRepository.append(event);

      // Publish to Inngest for worker processing
      // Note: Inngest events use a different format (name/data)
      await inngest.send({
        name: 'api/event.logged',
        data: {
          eventId: storedEvent.id,
          eventType: storedEvent.eventType,
          aggregateId: storedEvent.aggregateId,
          userId: storedEvent.userId,
          timestamp: storedEvent.timestamp.toISOString(),
          correlationId: storedEvent.correlationId,
        },
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
  getRecentEvents: publicProcedure
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
        events: events.map(event => ({
          id: event.id,
          type: event.eventType,
          userId: event.userId,
          timestamp: event.timestamp.toISOString(),
          correlationId: event.correlationId,
          isError: event.eventType.toLowerCase().includes('error') ||
                   event.eventType.toLowerCase().includes('failed'),
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
  getTrace: publicProcedure
    .input(
      z.object({
        correlationId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const events = await eventRepository.getCorrelatedEvents(input.correlationId);

      return {
        correlationId: input.correlationId,
        events: events.map(event => ({
          id: event.id,
          type: event.eventType,
          timestamp: event.timestamp.toISOString(),
          userId: event.userId,
          aggregateId: event.aggregateId,
          data: event.data,
          metadata: event.metadata,
          causationId: event.causationId,
        })),
        totalEvents: events.length,
      };
    }),

  /**
   * Search events with advanced filters
   *
   * Supports filtering by user, event type, aggregate, date range, etc.
   * Useful for the Event Store Advanced Search feature.
   */
  searchEvents: publicProcedure
    .input(
      z.object({
        userId: z.string().optional(),
        eventType: z.string().optional(),
        aggregateType: z.string().optional(),
        aggregateId: z.string().optional(),
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
        aggregateType: input.aggregateType as any,
        aggregateId: input.aggregateId,
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
        aggregateType: input.aggregateType as any,
        fromDate: filters.fromDate,
        toDate: filters.toDate,
      });

      return {
        events: events.map(event => ({
          id: event.id,
          type: event.eventType,
          timestamp: event.timestamp.toISOString(),
          userId: event.userId,
          aggregateId: event.aggregateId,
          aggregateType: event.aggregateType,
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
        throw new Error(`Tool "${input.toolName}" not found. Available tools: ${dynamicToolRegistry.getToolNames().join(', ')}`);
      }

      const metadata = dynamicToolRegistry.getToolMetadata(input.toolName);

      // Extract schema properties for UI rendering
      const schema = tool.schema as any;
      const schemaShape = schema._def?.shape ? Object.keys(schema._def.shape()) : [];

      return {
        name: tool.name,
        description: tool.description,
        schema: {
          type: 'object',
          properties: schema._def?.shape ? schema._def.shape() : {},
          required: schemaShape,
        },
        metadata: {
          version: metadata?.version || 'unknown',
          source: metadata?.source || 'unknown',
          registeredAt: metadata?.registeredAt.toISOString(),
        },
      };
    }),

  /**
   * Execute tool for AI Tools Playground
   *
   * Allows testing tools in isolation without running the full AI agent.
   */
  executeTool: publicProcedure
    .input(
      z.object({
        toolName: z.string(),
        parameters: z.record(z.any()),
        userId: z.string(),
        threadId: z.string().default('playground'),
      })
    )
    .mutation(async ({ input }) => {
      const result = await dynamicToolRegistry.executeTool(
        input.toolName,
        input.parameters,
        {
          userId: input.userId,
          threadId: input.threadId,
        }
      );

      return {
        success: result.success,
        result: result.result,
        error: result.error,
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
  getDashboardMetrics: publicProcedure.query(async () => {
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
    const errorEvents = recentEvents.filter(e =>
      e.eventType.toLowerCase().includes('error') ||
      e.eventType.toLowerCase().includes('failed')
    );
    const errorRate = recentEvents.length > 0
      ? (errorEvents.length / recentEvents.length) * 100
      : 0;

    // Get system stats
    const sseStats = eventStreamManager.getStats();
    const toolsStats = dynamicToolRegistry.getStats();
    const handlersStats = handlerRegistry.getRegisteredEventTypes().length;

    // Determine overall health status
    let healthStatus: 'healthy' | 'degraded' | 'critical';
    if (errorRate > 10) {
      healthStatus = 'critical';
    } else if (errorRate > 5 || eventsPerSecond > 100) {
      healthStatus = 'degraded';
    } else {
      healthStatus = 'healthy';
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
      latestEvents: latestEvents.map(event => ({
        id: event.id,
        type: event.eventType,
        userId: event.userId,
        timestamp: event.timestamp.toISOString(),
        isError: event.eventType.toLowerCase().includes('error') ||
                 event.eventType.toLowerCase().includes('failed'),
      })),
    };
  }),

});
