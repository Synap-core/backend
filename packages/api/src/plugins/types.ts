/**
 * Plugin Types for Data Pod
 *
 * Defines the interface for Data Pod plugins.
 */

import type { AnyRouter } from "@trpc/server";
import type { StateGraph } from "@synap/ai";
import type { dynamicToolRegistry } from "@synap/ai";

/**
 * Thought Input for plugins
 */
export interface ThoughtInput {
  content: string;
  userId: string;
  context?: Record<string, unknown>;
}

/**
 * Thought Response from plugins
 */
export interface ThoughtResponse {
  success: boolean;
  requestId: string;
  events?: unknown[];
  error?: string;
}

/**
 * Data Pod Plugin Interface
 *
 * Plugins can extend the Data Pod with:
 * - REST services (external API calls)
 * - Agents (LangGraph local)
 * - API routers (new tRPC endpoints)
 * - Tools (AI tools)
 */
export interface DataPodPlugin {
  /** Unique plugin name */
  name: string;

  /** Plugin version */
  version: string;

  /** Whether the plugin is enabled */
  enabled: boolean;

  /** For REST plugins: process a thought via external service */
  processThought?(input: ThoughtInput): Promise<ThoughtResponse>;

  /**
   * For Agent plugins: register a LangGraph agent
   */
  registerAgent?(
    graph: StateGraph<any, any, any, any, any, any>,
  ): void;

  /** For API plugins: register a tRPC router */
  registerRouter?(): AnyRouter;

  /**
   * For Tool plugins: register tools
   */
  registerTools?(registry: typeof dynamicToolRegistry): void;

  /** Hook called when plugin is initialized */
  onInit?(): Promise<void>;

  /** Hook called when plugin is destroyed */
  onDestroy?(): Promise<void>;
}
