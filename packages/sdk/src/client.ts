/**
 * SynapSDK - Main SDK Client
 * 
 * Provides high-level APIs for interacting with Synap Data Pod.
 * All mutations go through event sourcing, all queries are direct reads.
 */

import { createSynapClient, type SynapClient as ClientType } from '@synap-core/client';
import { EntitiesAPI } from './resources/entities.js';
import { RelationsAPI } from './resources/relations.js';
import { EventsAPI } from './resources/events.js';
import { WorkspacesAPI } from './resources/workspaces.js';
import { ViewsAPI } from './resources/views.js';
import { PreferencesAPI } from './resources/preferences.js';

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
  
  /**
   * Real-time configuration (optional)
   */
  realtime?: {
    userId: string;
    userName: string;
  };
}

/**
 * Synap SDK - High-Level Client
 * 
 * @example
 * ```typescript
 * const synap = new SynapSDK({
 *   url: 'https://api.synap.app',
 *   apiKey: 'sk_...',
 *   realtime: {
 *     userId: 'user-123',
 *     userName: 'Alice',
 *   },
 * });
 * 
 * // Use resource APIs
 * const task = await synap.entities.create({ type: 'task', title: 'Call Marie' });
 * await synap.relations.create(task.id, personId, 'assigned_to');
 * const history = await synap.events.getHistory(task.id);
 * 
 * // Workspaces
 * const workspace = await synap.workspaces.create({ name: 'Team Workspace' });
 * 
 * // Views
 * const whiteboard = await synap.views.create({ 
 *   type: 'whiteboard', 
 *   name: 'Brainstorm',
 *   workspaceId: workspace.id 
 * });
 * 
 * // Real-time collaboration
 * synap.realtime?.connectPresence(whiteboard.id);
 * const ydoc = synap.realtime?.connectYjs(whiteboard.id);
 * ```
 */
export class SynapSDK {
  /** Internal client */
  private readonly _client: ClientType;

  /** Entities API - Generic entity operations */
  public readonly entities: EntitiesAPI;

  /** Relations API - Relationship management */
  public readonly relations: RelationsAPI;

  /** Events API - Event history and replay */
  public readonly events: EventsAPI;
  
  /** Workspaces API - Multi-user workspace management (V3.0) */
  public readonly workspaces: WorkspacesAPI;
  
  /** Views API - Whiteboards, timelines, kanban boards (V3.0) */
  public readonly views: ViewsAPI;
  
  /** Preferences API - User preferences (V3.0) */
  public readonly preferences: PreferencesAPI;

  constructor(config: SynapSDKConfig) {
    // Create underlying client
    this._client = createSynapClient({
      url: config.url,
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : config.headers,
      fetch: config.fetch,
      realtime: config.realtime,
    });

    // Initialize resource APIs
    this.entities = new EntitiesAPI(this._client);
    this.relations = new RelationsAPI(this._client);
    this.events = new EventsAPI(this._client);
    this.workspaces = new WorkspacesAPI(this._client);
    this.views = new ViewsAPI(this._client);
    this.preferences = new PreferencesAPI(this._client);
  }

  /**
   * Get direct access to underlying client
   * Use this for advanced operations not covered by SDK APIs
   */
  get client(): ClientType {
    return this._client;
  }
  
  /**
   * Get real-time client for WebSocket features
   */
  get realtime() {
    return this._client.realtime;
  }
}
