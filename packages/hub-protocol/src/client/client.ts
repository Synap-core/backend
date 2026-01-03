/**
 * Hub Protocol Client
 * 
 * Type-safe tRPC client for communicating with Synap Data Pod
 * via the Hub Protocol V1.0.
 * 
 * This client allows any Hub (Intelligence Hub or third-party Hub) to:
 * - Generate temporary access tokens
 * - Request read-only data from Data Pod
 * - Submit structured insights that will be transformed into events
 */

import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@synap/api';
import type { HubInsight } from '@synap/hub-protocol';
import { createLogger } from '@synap-core/core';
import type {
  HubProtocolClientConfig,
  HubScope,
  RequestDataFilters,
} from './types.js';

const logger = createLogger({ module: 'hub-protocol-client' });

// ============================================================================
// CLIENT CLASS
// ============================================================================

/**
 * Hub Protocol Client
 * 
 * Provides type-safe methods to interact with the Data Pod Hub Protocol.
 * 
 * @example
 * ```typescript
 * const client = new HubProtocolClient({
 *   dataPodUrl: 'http://localhost:3000',
 *   token: 'user-session-token',
 * });
 * 
 * const { token } = await client.generateAccessToken('req-123', ['preferences', 'notes']);
 * const data = await client.requestData(token, ['preferences', 'notes']);
 * await client.submitInsight(token, insight);
 * ```
 */
export class HubProtocolClient {
  private client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;
  private config: Required<Pick<HubProtocolClientConfig, 'retry'>> & Omit<HubProtocolClientConfig, 'retry'>;

  constructor(config: HubProtocolClientConfig) {
    this.config = {
      ...config,
      retry: {
        maxAttempts: config.retry?.maxAttempts ?? 3,
        delayMs: config.retry?.delayMs ?? 1000,
      },
    };

    // Create tRPC client
    this.client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${this.config.dataPodUrl}/trpc`,
          headers: async () => {
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              ...this.config.headers,
            };

            // Add authentication token
            let token: string | null = null;
            
            if (this.config.token) {
              token = this.config.token;
            } else if (this.config.getToken) {
              const result = await this.config.getToken();
              token = result || null;
            }

            if (token) {
              headers['Authorization'] = `Bearer ${token}`;
            }

            return headers;
          },
        }),
      ],
    });
  }

  /**
   * Update Data Pod URL
   * 
   * Allows updating the Data Pod URL dynamically (useful when handling multiple users).
   */
  updateDataPodUrl(dataPodUrl: string): void {
    this.config.dataPodUrl = dataPodUrl;
    // Recreate client with new URL
    this.client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${this.config.dataPodUrl}/trpc`,
          headers: async () => {
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              ...this.config.headers,
            };

            let token: string | null = null;
            
            if (this.config.token) {
              token = this.config.token;
            } else if (this.config.getToken) {
              const result = await this.config.getToken();
              token = result || null;
            }

            if (token) {
              headers['Authorization'] = `Bearer ${token}`;
            }

            return headers;
          },
        }),
      ],
    });
  }

  /**
   * Generate Access Token
   * 
   * Generates a temporary JWT token (1-5 minutes) for accessing user data.
   * This token must be used for subsequent requestData and submitInsight calls.
   * 
   * @param requestId - UUID of the Hub request
   * @param scope - Array of data scopes to access
   * @param expiresIn - Token expiration in seconds (60-300, default: 300)
   * @param userId - User ID for token generation (optional, will use authenticated user if not provided)
   * @returns JWT token, expiration timestamp, and request ID
   * 
   * @example
   * ```typescript
   * const { token, expiresAt } = await client.generateAccessToken(
   *   'req-123',
   *   ['preferences', 'notes', 'tasks'],
   *   300
   * );
   * ```
   */
  async generateAccessToken(
    requestId: string,
    scope: HubScope[],
    expiresIn: number = 300,
    userId?: string
  ): Promise<{ token: string; expiresAt: number; requestId: string }> {
    logger.debug({ requestId, scope, expiresIn, userId }, 'Generating access token');

    try {
      // Type assertion needed because AppRouter is built dynamically
      const result = await (this.client.hub as any).generateAccessToken.mutate({
        requestId,
        scope,
        expiresIn,
      });

      logger.info({ requestId, expiresAt: result.expiresAt }, 'Access token generated');
      return result;
    } catch (error) {
      logger.error({ err: error, requestId, scope }, 'Failed to generate access token');
      throw this.handleError(error, 'generateAccessToken');
    }
  }

  /**
   * Request Data
   * 
   * Retrieves read-only data from the Data Pod based on the provided scope.
   * Requires a valid JWT token from generateAccessToken.
   * 
   * @param token - JWT token from generateAccessToken
   * @param scope - Array of data scopes to retrieve
   * @param filters - Optional filters (date range, entity types, pagination)
   * @returns User data according to scope
   * 
   * @example
   * ```typescript
   * const data = await client.requestData(
   *   token,
   *   ['preferences', 'notes'],
   *   {
   *     dateRange: {
   *       start: '2025-01-01T00:00:00Z',
   *       end: '2025-12-31T23:59:59Z',
   *     },
   *     limit: 100,
   *   }
   * );
   * ```
   */
  async requestData(
    token: string,
    scope: HubScope[],
    filters?: RequestDataFilters
  ): Promise<{
    userId: string;
    requestId: string;
    data: Record<string, unknown>;
    metadata: {
      retrievedAt: string;
      scope: string[];
      recordCount: number;
    };
  }> {
    logger.debug({ scope, hasFilters: !!filters }, 'Requesting data from Data Pod');

    try {
      // Type assertion needed because AppRouter is built dynamically
      const result = await (this.client.hub as any).requestData.query({
        token,
        scope,
        filters,
      });

      logger.info({ 
        requestId: result.requestId, 
        recordCount: result.metadata.recordCount 
      }, 'Data retrieved from Data Pod');
      
      return result;
    } catch (error) {
      logger.error({ err: error, scope }, 'Failed to request data');
      throw this.handleError(error, 'requestData');
    }
  }

  /**
   * Submit Insight
   * 
   * Submits a structured insight that will be transformed into SynapEvent objects
   * and published to the Event Store.
   * Requires a valid JWT token from generateAccessToken.
   * 
   * @param token - JWT token from generateAccessToken
   * @param insight - Structured HubInsight (validated with HubInsightSchema)
   * @returns Success status and event IDs
   * 
   * @example
   * ```typescript
   * const result = await client.submitInsight(token, {
   *   version: '1.0',
   *   type: 'action_plan',
   *   correlationId: 'req-123',
   *   actions: [
   *     {
   *       eventType: 'task.creation.requested',
   *       data: { title: 'My Task' },
   *       requiresConfirmation: false,
   *     },
   *   ],
   *   confidence: 0.95,
   *   reasoning: 'Based on user preferences',
   * });
   * ```
   */
  async submitInsight(
    token: string,
    insight: HubInsight
  ): Promise<{
    success: boolean;
    requestId: string;
    eventIds: string[];
    eventsCreated: number;
    errors?: Array<{ actionIndex: number; error: string }>;
  }> {
    logger.debug({ 
      insightType: insight.type, 
      correlationId: insight.correlationId 
    }, 'Submitting insight to Data Pod');

    try {
      // Type assertion needed because AppRouter is built dynamically
      const result = await (this.client.hub as any).submitInsight.mutate({
        token,
        insight,
      });

      logger.info({ 
        requestId: result.requestId, 
        eventsCreated: result.eventsCreated,
        success: result.success 
      }, 'Insight submitted to Data Pod');
      
      return result;
    } catch (error) {
      logger.error({ err: error, insightType: insight.type }, 'Failed to submit insight');
      throw this.handleError(error, 'submitInsight');
    }
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  /**
   * Handle errors with retry logic
   */
  private async handleError(error: unknown, operation: string): Promise<never> {
    // If it's a TRPCClientError, extract the message
    if (error instanceof TRPCClientError) {
      logger.error({ 
        operation, 
        code: error.data?.code,
        message: error.message 
      }, 'TRPC client error');
      
      throw new Error(`Hub Protocol ${operation} failed: ${error.message}`);
    }

    // For other errors, wrap them
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Hub Protocol ${operation} failed: ${message}`);
  }
}

