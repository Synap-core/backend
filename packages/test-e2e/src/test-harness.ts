/**
 * E2E Test Harness
 *
 * Enhanced test utilities for backend-only E2E testing:
 * - tRPC client factory with auth
 * - Event stream listener for real-time assertions
 * - Inngest event spy
 * - Test data factories
 */

import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@synap/api";
import { createLogger } from "@synap-core/core";
import { EventEmitter } from "events";
import type { TestUser } from "./setup.js";

const logger = createLogger({ module: "test-harness" });

export interface TRPCTestClient {
  client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;
  userId: string;
  workspaceId?: string;
}

/**
 * Event Stream Listener
 *
 * Listens to SSE events from the backend for real-time assertions
 */
export class EventStreamListener extends EventEmitter {
  private eventSource: EventSource | null = null;
  private connected = false;

  constructor(private apiUrl: string, private sessionCookie: string) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // SSE endpoint for admin events
      const url = `${this.apiUrl}/admin/events/stream`;
      
      this.eventSource = new EventSource(url, {
        headers: {
          Cookie: this.sessionCookie,
        },
      } as any);

      this.eventSource.onopen = () => {
        this.connected = true;
        logger.info("Event stream connected");
        resolve();
      };

      this.eventSource.onerror = (error) => {
        logger.error({ error }, "Event stream error");
        if (!this.connected) {
          reject(error);
        }
      };

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.emit("event", data);
          
          // Emit specific event type
          if (data.type) {
            this.emit(data.type, data);
          }
        } catch (error) {
          logger.error({ error, data: event.data }, "Failed to parse event");
        }
      };

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Event stream connection timeout"));
        }
      }, 5000);
    });
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.connected = false;
      logger.info("Event stream disconnected");
    }
  }

  /**
   * Wait for a specific event type
   */
  async waitForEvent(
    eventType: string,
    timeout = 10000,
    filter?: (data: any) => boolean
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(eventType, handler);
        reject(new Error(`Timeout waiting for event: ${eventType}`));
      }, timeout);

      const handler = (data: any) => {
        if (filter && !filter(data)) {
          return; // Keep waiting
        }
        clearTimeout(timer);
        this.off(eventType, handler);
        resolve(data);
      };

      this.on(eventType, handler);
    });
  }
}

/**
 * Create authenticated tRPC client
 */
export function createTestClient(
  apiUrl: string,
  user: TestUser
): TRPCTestClient {
  const client = createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiUrl}/trpc`,
        headers: {
          Cookie: user.sessionCookie || "",
        },
        // Add timeout to prevent indefinite hangs
        fetch: async (url, options) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          try {
            const response = await fetch(url, {
              ...options,
              signal: controller.signal,
            });
            return response;
          } finally {
            clearTimeout(timeoutId);
          }
        },
      }),
    ],
  });

  return {
    client,
    userId: user.id,
  };
}

/**
 * Inngest Event Spy
 *
 * Monitors Inngest events for testing
 */
export class InngestEventSpy {
  private events: Array<{ name: string; data: any; timestamp: Date }> = [];

  constructor(private apiUrl: string) {}

  /**
   * Poll Inngest for events (requires Inngest dev server)
   */
  async getEvents(filter?: { name?: string }): Promise<any[]> {
    // In a real implementation, we'd query the Inngest dev server API
    // For now, we return captured events
    if (filter?.name) {
      return this.events.filter((e) => e.name === filter.name);
    }
    return this.events;
  }

  /**
   * Wait for a specific event to be processed by Inngest
   */
  async waitForEvent(
    eventName: string,
    timeout = 10000
  ): Promise<any> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const events = await this.getEvents({ name: eventName });
      if (events.length > 0) {
        return events[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Timeout waiting for Inngest event: ${eventName}`);
  }

  clear(): void {
    this.events = [];
  }
}

/**
 * Test Data Factories
 */
export const testDataFactory = {
  /**
   * Create workspace with settings
   */
  workspace: (overrides?: Partial<any>) => ({
    name: `Test Workspace ${Date.now()}`,
    settings: {
      aiAutoApprove: false,
      ...overrides?.settings,
    },
    ...overrides,
  }),

  /**
   * Create entity data
   */
  entity: (type: string, overrides?: Partial<any>) => ({
    type,
    title: `Test ${type} ${Date.now()}`,
    metadata: {
      source: "user",
      ...overrides?.metadata,
    },
    ...overrides,
  }),

  /**
   * Create AI entity with source=ai
   */
  aiEntity: (type: string, overrides?: Partial<any>) => ({
    type,
    title: `AI ${type} ${Date.now()}`,
    metadata: {
      source: "ai",
      confidence: 0.95,
      ...overrides?.metadata,
    },
    ...overrides,
  }),
};

/**
 * Database helpers for assertions
 */
export class DatabaseTestHelpers {
  constructor(private db: any) {}

  /**
   * Check if proposal exists
   */
  async hasProposal(targetId: string): Promise<boolean> {
    const { proposals, eq } = await import("@synap/database");
    const [proposal] = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.targetId, targetId))
      .limit(1);
    return !!proposal;
  }

  /**
   * Get proposal by target ID
   */
  async getProposal(targetId: string): Promise<any | null> {
    const { proposals, eq } = await import("@synap/database");
    const [proposal] = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.targetId, targetId))
      .limit(1);
    return proposal || null;
  }

  /**
   * Check if entity exists
   */
  async hasEntity(entityId: string): Promise<boolean> {
    const { entities, eq } = await import("@synap/database");
    const [entity] = await this.db
      .select()
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    return !!entity;
  }

  /**
   * Clean up test data
   */
  async cleanup(workspaceId: string): Promise<void> {
    const { entities, proposals, eq } = await import("@synap/database");
    
    logger.info({ workspaceId }, "Cleaning up test data");
    
    // Delete test entities
    await this.db.delete(entities).where(eq(entities.workspaceId, workspaceId));
    
    // Delete test proposals
    await this.db.delete(proposals).where(eq(proposals.workspaceId, workspaceId));
  }
}

/**
 * Wait helper
 */
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry helper for eventually consistent operations
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  options: { timeout?: number; interval?: number } = {}
): Promise<T> {
  const timeout = options.timeout || 10000;
  const interval = options.interval || 500;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await fn();
    if (condition(result)) {
      return result;
    }
    await wait(interval);
  }

  throw new Error("Retry timeout exceeded");
}
