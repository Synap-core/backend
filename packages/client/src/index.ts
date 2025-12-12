/**
 * @synap/client - Type-safe Client SDK for Synap Core OS
 * 
 * Hybrid 3-layer architecture:
 * 1. Core RPC (auto-generated): Direct tRPC access via client.rpc.*
 * 2. Business Facade: High-level convenience methods via client.notes.*, client.chat.*, etc.
 * 3. Authentication: Agnostic token management via getToken()
 */

import { createRPCClient, type SynapClientConfig } from './core.js';
import type { TRPCClient } from '@trpc/client';
import type { AppRouter } from './types.js';
import {
  NotesFacade,
  ChatFacade,
  TasksFacade,
  CaptureFacade,
  SystemFacade,
} from './facade.js';
import { ContentFacade } from './facades/content.js';

/**
 * Synap Client
 * 
 * Main client class providing both high-level and low-level access to the Synap API.
 * 
 * @example
 * ```typescript
 * // High-level API (recommended for most use cases)
 * const synap = new SynapClient({
 *   url: 'http://localhost:3000',
 *   getToken: async () => await getSessionToken(),
 * });
 * 
 * await synap.notes.create({ content: '# My Note' });
 * 
 * // Low-level API (for power users)
 * await synap.rpc.notes.create.mutate({ content: '# My Note' });
 * ```
 */
export class SynapClient {
  /** Core RPC client - Direct access to all tRPC procedures */
  public readonly rpc: TRPCClient<AppRouter>;

  /** Notes facade - High-level note operations */
  public readonly notes: NotesFacade;

  /** Chat facade - High-level chat operations */
  public readonly chat: ChatFacade;

  /** Tasks facade - High-level task operations */
  public readonly tasks: TasksFacade;

  /** Capture facade - Thought capture operations */
  public readonly capture: CaptureFacade;

  /** System facade - System information and health */
  public readonly system: SystemFacade;

  /** Content facade - Unified content creation (notes & files) */
  public readonly content: ContentFacade;

  private config: SynapClientConfig;

  constructor(config: SynapClientConfig) {
    this.config = { ...config };
    
    // Initialize core RPC client (Couche 1)
    const rpc = createRPCClient(this.config);
    
    // Initialize business facades (Couche 2)
    const notes = new NotesFacade(rpc);
    const chat = new ChatFacade(rpc);
    const tasks = new TasksFacade(rpc);
    const capture = new CaptureFacade(rpc);
    const system = new SystemFacade(rpc);
    const content = new ContentFacade(rpc);

    // Assign readonly properties
    this.rpc = rpc;
    this.notes = notes;
    this.chat = chat;
    this.tasks = tasks;
    this.capture = capture;
    this.system = system;
    this.content = content;
  }

  /**
   * Update the authentication token
   * 
   * Useful when tokens expire and need to be refreshed.
   * 
   * Note: This creates a new client instance. Consider creating a new SynapClient instead.
   */
  updateToken(getToken: () => Promise<string | null> | string | null): SynapClient {
    return new SynapClient({
      ...this.config,
      getToken,
    });
  }

  /**
   * Get the real-time WebSocket URL for this client
   * 
   * This is useful for connecting to the real-time notification system.
   */
  getRealtimeUrl(userId: string): string {
    // Use custom realtimeUrl if provided, otherwise convert http/https to wss
    let baseUrl = this.config.realtimeUrl;
    if (!baseUrl) {
      if (this.config.url) {
        baseUrl = this.config.url.replace(/^https?/, 'wss');
      } else {
        baseUrl = 'wss://realtime.synap.app';
      }
    }
    
    // Ensure base URL doesn't have trailing slash
    baseUrl = baseUrl.replace(/\/$/, '');
    
    return `${baseUrl}/rooms/user_${userId}/subscribe`;
  }
}

// Export types
export type { SynapClientConfig, AppRouter } from './types.js';
export type { TRPCClient } from '@trpc/client';

// Default export
export default SynapClient;

