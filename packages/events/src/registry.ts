/**
 * @synap/events - Event Registry
 * 
 * Runtime registry for event types and handlers.
 * Tracks which events are registered and their metadata.
 */

// Types imported from generator as needed

// ============================================================================
// TYPES
// ============================================================================

export interface EventRegistration {
  eventType: string;
  table: string;
  action: string;
  source: 'generated' | 'custom';
  description?: string;
  hasWorker: boolean;
  workerId?: string;
  registeredAt: Date;
}

export interface EventRegistryStats {
  totalEvents: number;
  generatedEvents: number;
  customEvents: number;
  eventsWithWorkers: number;
  eventsByTable: Record<string, number>;
}

// ============================================================================
// REGISTRY
// ============================================================================

class EventRegistry {
  private events = new Map<string, EventRegistration>();
  
  /**
   * Register an event type
   */
  register(eventType: string, options: Partial<EventRegistration> = {}): void {
    const parts = eventType.split('.');
    const table = parts[0] || 'unknown';
    const action = parts.slice(1).join('.') || 'unknown';
    
    this.events.set(eventType, {
      eventType,
      table,
      action,
      source: options.source ?? 'custom',
      description: options.description,
      hasWorker: options.hasWorker ?? false,
      workerId: options.workerId,
      registeredAt: new Date(),
    });
  }
  
  /**
   * Register a worker for an event type
   */
  registerWorker(eventType: string, workerId: string): void {
    const existing = this.events.get(eventType);
    if (existing) {
      existing.hasWorker = true;
      existing.workerId = workerId;
    } else {
      this.register(eventType, { hasWorker: true, workerId });
    }
  }
  
  /**
   * Get all registered events
   */
  getAll(): EventRegistration[] {
    return Array.from(this.events.values());
  }
  
  /**
   * Get events by table
   */
  getByTable(table: string): EventRegistration[] {
    return this.getAll().filter(e => e.table === table);
  }
  
  /**
   * Get events with workers
   */
  getWithWorkers(): EventRegistration[] {
    return this.getAll().filter(e => e.hasWorker);
  }
  
  /**
   * Check if an event type is registered
   */
  has(eventType: string): boolean {
    return this.events.has(eventType);
  }
  
  /**
   * Get registry statistics
   */
  getStats(): EventRegistryStats {
    const all = this.getAll();
    const eventsByTable: Record<string, number> = {};
    
    for (const event of all) {
      eventsByTable[event.table] = (eventsByTable[event.table] || 0) + 1;
    }
    
    return {
      totalEvents: all.length,
      generatedEvents: all.filter(e => e.source === 'generated').length,
      customEvents: all.filter(e => e.source === 'custom').length,
      eventsWithWorkers: all.filter(e => e.hasWorker).length,
      eventsByTable,
    };
  }
  
  /**
   * Clear all registrations (for testing)
   */
  clear(): void {
    this.events.clear();
  }
}

/**
 * Singleton event registry instance
 */
export const eventRegistry = new EventRegistry();

// ============================================================================
// AUTO-REGISTRATION
// ============================================================================

import { getAllGeneratedEventTypes, CORE_TABLES } from './generator.js';

/**
 * Register all generated event types
 */
export function registerGeneratedEvents(): void {
  const events = getAllGeneratedEventTypes();
  
  for (const eventType of events) {
    eventRegistry.register(eventType, {
      source: 'generated',
      description: `Auto-generated event for ${eventType}`,
    });
  }
}

/**
 * Get table names with their event counts
 */
export function getTableEventSummary(): Record<string, { total: number; withWorkers: number }> {
  const summary: Record<string, { total: number; withWorkers: number }> = {};
  
  for (const table of CORE_TABLES) {
    const events = eventRegistry.getByTable(table);
    summary[table] = {
      total: events.length,
      withWorkers: events.filter(e => e.hasWorker).length,
    };
  }
  
  return summary;
}
