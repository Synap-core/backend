/**
 * Event logging system for observability
 * 
 * Logs all operations to events.jsonl for:
 * - Cost tracking
 * - Performance monitoring
 * - Debugging
 * - Usage analytics
 */

import fs from 'fs/promises';
import path from 'path';

export type EventType =
  | 'note_created'
  | 'note_updated'
  | 'note_deleted'
  | 'search_executed'
  | 'ai_enrichment'
  | 'rag_indexed'
  | 'git_commit'
  | 'chat_branch_created'
  | 'chat_branch_merged'
  | 'system_init'
  | 'system_shutdown'
  | 'error';

export interface SystemEvent {
  timestamp: string;
  event: EventType;
  entity_id?: string;
  source: 'user' | 'system' | 'ai_agent';
  data?: Record<string, any>;
  cost?: number; // USD
  latency?: number; // milliseconds
  error?: string;
}

export class EventLogger {
  private logPath: string;
  private buffer: SystemEvent[];
  private flushInterval: NodeJS.Timeout | null;

  constructor(basePath: string, options?: { autoFlush?: boolean; flushIntervalMs?: number }) {
    this.logPath = path.join(basePath, 'events.jsonl');
    this.buffer = [];
    this.flushInterval = null;

    // Auto-flush every 5 seconds by default
    if (options?.autoFlush !== false) {
      const interval = options?.flushIntervalMs || 5000;
      this.flushInterval = setInterval(() => this.flush(), interval);
    }
  }

  /**
   * Log an event
   */
  async log(event: Omit<SystemEvent, 'timestamp'>): Promise<void> {
    const fullEvent: SystemEvent = {
      timestamp: new Date().toISOString(),
      ...event
    };

    this.buffer.push(fullEvent);

    // Auto-flush if buffer is large (100 events)
    if (this.buffer.length >= 100) {
      await this.flush();
    }
  }

  /**
   * Flush buffered events to disk
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    try {
      const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(this.logPath, lines, 'utf-8');
    } catch (error) {
      console.error('Failed to flush events:', (error as Error).message);
      // Put events back in buffer
      this.buffer.unshift(...events);
    }
  }

  /**
   * Read events from log file
   */
  async readEvents(options?: { 
    since?: Date; 
    eventType?: EventType; 
    limit?: number;
  }): Promise<SystemEvent[]> {
    try {
      const content = await fs.readFile(this.logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      
      let events = lines.map(line => JSON.parse(line) as SystemEvent);

      // Filter by timestamp
      if (options?.since) {
        events = events.filter(e => new Date(e.timestamp) >= options.since!);
      }

      // Filter by event type
      if (options?.eventType) {
        events = events.filter(e => e.event === options.eventType);
      }

      // Limit results
      if (options?.limit) {
        events = events.slice(-options.limit);
      }

      return events;
    } catch (error) {
      // File doesn't exist yet or is empty
      return [];
    }
  }

  /**
   * Get statistics from events
   */
  async getStats(since?: Date): Promise<{
    totalEvents: number;
    eventsByType: Record<string, number>;
    totalCost: number;
    avgLatency: number;
    errors: number;
  }> {
    const events = await this.readEvents({ since });

    const stats = {
      totalEvents: events.length,
      eventsByType: {} as Record<string, number>,
      totalCost: 0,
      avgLatency: 0,
      errors: 0
    };

    let totalLatency = 0;
    let latencyCount = 0;

    for (const event of events) {
      // Count by type
      stats.eventsByType[event.event] = (stats.eventsByType[event.event] || 0) + 1;

      // Sum costs
      if (event.cost) {
        stats.totalCost += event.cost;
      }

      // Average latency
      if (event.latency) {
        totalLatency += event.latency;
        latencyCount++;
      }

      // Count errors
      if (event.event === 'error' || event.error) {
        stats.errors++;
      }
    }

    if (latencyCount > 0) {
      stats.avgLatency = totalLatency / latencyCount;
    }

    return stats;
  }

  /**
   * Cleanup and stop auto-flush
   */
  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }
}


