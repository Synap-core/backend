/**
 * Dynamic Router Registry
 * 
 * V1.0 Ecosystem Extensibility: Allows routers to be registered dynamically
 * 
 * This registry enables the ecosystem vision where API routers can be added via plugins
 * without modifying core code. Routers can be registered at runtime.
 */

import type { AnyRouter } from '@trpc/server';
import { router } from './trpc.js';
import { createLogger, ConflictError } from '@synap/core';

const logger = createLogger({ module: 'router-registry' });

/**
 * Router Registration Metadata
 */
export interface RouterMetadata {
  name: string;
  version?: string;
  source?: string;
  registeredAt: Date;
  description?: string;
}

/**
 * Dynamic Router Registry
 * 
 * Maintains a map of registered routers that can be added/removed at runtime.
 * This enables plugin-based API extensibility.
 */
class DynamicRouterRegistry {
  private routers: Map<string, { router: AnyRouter; metadata: RouterMetadata }> = new Map();

  /**
   * Register a router dynamically
   * 
   * @param name - Router name (e.g., 'notes', 'chat', 'tasks')
   * @param routerInstance - The tRPC router instance
   * @param metadata - Optional metadata about the router
   * @throws Error if router name is already registered
   * 
   * @example
   * ```typescript
   * registry.register('myPlugin', myPluginRouter, {
   *   version: '1.0.0',
   *   source: 'my-plugin',
   *   description: 'My plugin router',
   * });
   * ```
   */
  register(
    name: string,
    routerInstance: AnyRouter,
    metadata?: { version?: string; source?: string; description?: string }
  ): void {
    if (this.routers.has(name)) {
      throw new ConflictError(`Router "${name}" is already registered. Use unregister() first to replace it.`, { routerName: name });
    }

    const routerMetadata: RouterMetadata = {
      name,
      version: metadata?.version || '1.0.0',
      source: metadata?.source || 'unknown',
      registeredAt: new Date(),
      description: metadata?.description,
    };

    this.routers.set(name, {
      router: routerInstance,
      metadata: routerMetadata,
    });

    logger.info({ routerName: name, source: metadata?.source }, 'Router registered');
  }

  /**
   * Unregister a router
   * 
   * @param name - Name of the router to unregister
   * @returns true if router was removed, false if it didn't exist
   */
  unregister(name: string): boolean {
    const removed = this.routers.delete(name);
    
    if (removed) {
      logger.info({ routerName: name }, 'Router unregistered');
    }
    
    return removed;
  }

  /**
   * Get a router by name
   * 
   * @param name - Name of the router to retrieve
   * @returns The router instance or undefined if not found
   */
  getRouter(name: string): AnyRouter | undefined {
    return this.routers.get(name)?.router;
  }

  /**
   * Get router metadata
   * 
   * @param name - Name of the router
   * @returns Router metadata or undefined if not found
   */
  getRouterMetadata(name: string): RouterMetadata | undefined {
    return this.routers.get(name)?.metadata;
  }

  /**
   * Get all registered routers
   * 
   * @returns Map of router names to router instances
   */
  getAllRouters(): Map<string, AnyRouter> {
    const result = new Map<string, AnyRouter>();
    for (const [name, { router: routerInstance }] of this.routers.entries()) {
      result.set(name, routerInstance);
    }
    return result;
  }

  /**
   * Get all registered router names
   * 
   * @returns Array of registered router names
   */
  getRouterNames(): string[] {
    return Array.from(this.routers.keys());
  }

  /**
   * Check if a router is registered
   * 
   * @param name - Name of the router
   * @returns true if router is registered, false otherwise
   */
  hasRouter(name: string): boolean {
    return this.routers.has(name);
  }

  /**
   * Build the main app router from all registered routers
   * 
   * This creates a single tRPC router that merges all registered routers.
   * 
   * @returns The merged app router
   */
  buildAppRouter(): AnyRouter {
    const routerMap: Record<string, AnyRouter> = {};
    
    for (const [name, { router: routerInstance }] of this.routers.entries()) {
      routerMap[name] = routerInstance;
    }

    return router(routerMap);
  }

  /**
   * Clear all registered routers (useful for testing)
   */
  clear(): void {
    this.routers.clear();
    logger.info('Router registry cleared');
  }

  /**
   * Get registry statistics
   * 
   * @returns Statistics about registered routers
   */
  getStats(): {
    totalRouters: number;
    routersBySource: Record<string, number>;
    routerNames: string[];
  } {
    const routersBySource: Record<string, number> = {};
    
    for (const { metadata } of this.routers.values()) {
      routersBySource[metadata.source || 'unknown'] = (routersBySource[metadata.source || 'unknown'] || 0) + 1;
    }

    return {
      totalRouters: this.routers.size,
      routersBySource,
      routerNames: this.getRouterNames(),
    };
  }
}

/**
 * Singleton instance of the dynamic router registry
 * 
 * This is the global registry that all routers should register with.
 * Plugins can register their routers here at runtime.
 */
export const dynamicRouterRegistry = new DynamicRouterRegistry();

/**
 * Convenience functions for plugin developers
 */
export const registerRouter = (
  name: string,
  routerInstance: AnyRouter,
  metadata?: { version?: string; source?: string; description?: string }
) => dynamicRouterRegistry.register(name, routerInstance, metadata);

export const unregisterRouter = (name: string) => dynamicRouterRegistry.unregister(name);

export const getRouter = (name: string) => dynamicRouterRegistry.getRouter(name);

export const buildAppRouter = () => dynamicRouterRegistry.buildAppRouter();

