/**
 * Handler Registry - Phase 2: Worker Layer
 * 
 * Central registry for all event handlers.
 * The dispatcher uses this registry to find handlers for each event type.
 */

import type { IEventHandler } from './interface.js';

/**
 * Handler Registry
 * 
 * Maintains a map of event types to their handlers.
 * Multiple handlers can subscribe to the same event type.
 */
class HandlerRegistry {
  private handlers: Map<string, IEventHandler[]> = new Map();

  /**
   * Register a handler for an event type
   * 
   * @param handler - The handler to register
   */
  register(handler: IEventHandler): void {
    const eventType = handler.eventType;
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler);
  }

  /**
   * Get all handlers for an event type
   * 
   * @param eventType - The event type to get handlers for
   * @returns Array of handlers (empty if none registered)
   */
  getHandlers(eventType: string): IEventHandler[] {
    return this.handlers.get(eventType) || [];
  }

  /**
   * Get all registered event types
   * 
   * @returns Array of event types that have handlers
   */
  getRegisteredEventTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Clear all handlers (for testing)
   */
  clear(): void {
    this.handlers.clear();
  }
}

/**
 * Singleton handler registry instance
 */
export const handlerRegistry = new HandlerRegistry();

