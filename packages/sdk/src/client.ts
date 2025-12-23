/**
 * SynapSDK - Main SDK Client
 * 
 * Provides high-level APIs for interacting with Synap Data Pod.
 * All mutations go through event sourcing, all queries are direct reads.
 */

import { createSynapClient, type SynapClient as TRPCClient } from '@synap/client';
import { EntitiesAPI } from './resources/entities.js';
import { RelationsAPI } from './resources/relations.js';
import { EventsAPI } from './resources/events.js';

/**
 * SDK Configuration
 */
export interface SynapSDKConfig {
  /**
   * Base URL for the Synap API
   * @example 'https://api.synap.app' or 'http://localhost:3000'
   */
  url: string;

  /**
   * API key or authentication token
   * Either provide apiKey OR headers function
   */
  apiKey?: string;

  /**
   * Custom headers function for dynamic authentication
   * @example () => ({ Authorization: `Bearer ${getToken()}` })
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;

  /**
   * Custom fetch implementation (for React Native, etc.)
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Synap SDK - High-Level Client
 * 
 * @example
 * ```typescript
 * const synap = new SynapSDK({
 *   url: 'https://api.synap.app',
 *   apiKey: 'sk_...'
 * });
 * 
 * // Use resource APIs
 * const task = await synap.entities.create({ type: 'task', title: 'Call Marie' });
 * await synap.relations.create(task.id, personId, 'assigned_to');
 * const history = await synap.events.getHistory(task.id);
 * ```
 */
export class SynapSDK {
  /** Internal tRPC client */
  private readonly trpc: TRPCClient;

  /** Entities API - Generic entity operations */
  public readonly entities: EntitiesAPI;

  /** Relations API - Relationship management */
  public readonly relations: RelationsAPI;

  /** Events API - Event history and replay */
  public readonly events: EventsAPI;

  constructor(config: SynapSDKConfig) {
    // Create underlying tRPC client
    this.trpc = createSynapClient({
      url: config.url,
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : config.headers,
      fetch: config.fetch,
    });

    // Initialize resource APIs
    this.entities = new EntitiesAPI(this.trpc);
    this.relations = new RelationsAPI(this.trpc);
    this.events = new EventsAPI(this.trpc);
  }

  /**
   * Get direct access to underlying tRPC client
   * Use this for advanced operations not covered by SDK APIs
   */
  get client(): TRPCClient {
    return this.trpc;
  }
}
