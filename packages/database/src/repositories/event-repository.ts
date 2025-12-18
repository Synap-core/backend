/**
 * Event Repository - Event Sourcing Abstraction
 *
 * Phase 1: Event Store Foundation
 *
 * This repository is the single point of entry for all events.
 * It validates events against the SynapEvent v1 schema before insertion.
 *
 * Features:
 * - Schema validation at insertion (Zod)
 * - Append events with optimistic locking
 * - Event replay (get aggregate stream)
 * - User event streams
 * - Correlation tracking
 * - Row-Level Security integration
 * - Event hooks for real-time broadcasting
 */

import type postgres from 'postgres';
import { SynapEventSchema, type SynapEvent } from '@synap/core';

/**
 * Event Hook Callback Type
 *
 * Functions that want to be notified when events are appended
 * can register a hook using EventRepository.addEventHook()
 */
export type EventHook = (event: EventRecord) => void | Promise<void>;

// ============================================================================
// LEGACY TYPES (for backward compatibility during migration)
// ============================================================================

export enum AggregateType {
  ENTITY = 'entity',
  RELATION = 'relation',
  USER = 'user',
  SYSTEM = 'system',
}

export enum EventSource {
  API = 'api',
  AUTOMATION = 'automation',
  SYNC = 'sync',
  MIGRATION = 'migration',
  SYSTEM = 'system',
}

/**
 * EventRecord - Database representation of an event
 * 
 * This is the format returned from the database.
 * It maps directly to the events_timescale table structure.
 */
export interface EventRecord {
  id: string;
  timestamp: Date;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  userId: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  version: number;
  causationId?: string;
  correlationId?: string;
  source: string;
}

export interface EventStreamOptions {
  fromVersion?: number;
  toVersion?: number;
  eventTypes?: string[];
}

export interface UserStreamOptions {
  days?: number;
  limit?: number;
  eventTypes?: string[];
  aggregateTypes?: AggregateType[];
}

// ============================================================================
// EVENT REPOSITORY
// ============================================================================

export class EventRepository {
  private eventHooks: EventHook[] = [];

  // Accept postgres.js Sql instance
  constructor(private sql: ReturnType<typeof postgres>) {}

  /**
   * Query wrapper for postgres.js
   * Converts .query(sqlString, params[]) to postgres.js template literal format
   * This maintains compatibility with existing query code
   */
  private async query(sqlString: string, params?: any[]): Promise<{ rows: any[] }> {
    // Convert to safe postgres.js query
    const rows = await this.sql.unsafe(sqlString, params || []);
    return { rows };
  }

  /**
   * Add an event hook
   *
   * Hooks are called after an event is successfully appended to the store.
   * Useful for real-time broadcasting, analytics, etc.
   *
   * @param hook - Callback function to be called on each event
   */
  addEventHook(hook: EventHook): void {
    this.eventHooks.push(hook);
  }

  /**
   * Remove an event hook
   *
   * @param hook - The hook function to remove
   */
  removeEventHook(hook: EventHook): void {
    this.eventHooks = this.eventHooks.filter(h => h !== hook);
  }

  /**
   * Notify all event hooks
   *
   * @param event - The event record to broadcast
   */
  private async notifyHooks(event: EventRecord): Promise<void> {
    // Fire all hooks in parallel
    await Promise.allSettled(
      this.eventHooks.map(hook => Promise.resolve(hook(event)))
    );
  }

  /**
   * Get event by ID
   */
  async findById(id: string): Promise<EventRecord | null> {
    const result = await this.query(`
      SELECT * FROM events_timescale
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  /**
   * Append event to stream
   *
   * Phase 1: This is the single validation point for all events.
   * Events are validated against SynapEvent v1 schema before insertion.
   *
   * Includes optimistic concurrency check for aggregates.
   *
   * @param event - SynapEvent to append (validated against schema)
   * @returns EventRecord (database representation)
   * @throws Error if event is invalid or version conflict detected
   */
  async append(event: SynapEvent): Promise<EventRecord> {
    // PHASE 1: Validate event against SynapEvent schema
    // This is the single point of validation - all events must pass this check
    const validated = SynapEventSchema.parse(event);
    
    // Optimistic concurrency check (if aggregateId is provided)
    // Note: For Phase 1, we use a simplified versioning approach
    // In future phases, we'll implement full optimistic locking
    if (validated.aggregateId) {
      // Future: Check current version and validate
      // const currentVersion = await this.getAggregateVersion(validated.aggregateId);
    }

    // Map SynapEvent to database structure
    // Note: We need to extract aggregate_type from event type or metadata
    // For Phase 1, we'll infer it from the event type pattern
    const aggregateType = this.inferAggregateType(validated.type);
    
    // Store version and requestId in metadata
    const metadata = {
      version: validated.version,
      requestId: validated.requestId,
    };

    try {
      const result = await this.query(`
        INSERT INTO events_timescale (
          id,
          aggregate_id,
          aggregate_type,
          event_type,
          user_id,
          data,
          metadata,
          version,
          causation_id,
          correlation_id,
          source,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        validated.id,
        validated.aggregateId || validated.id, // Use event ID as aggregate if not provided
        aggregateType,
        validated.type,
        validated.userId,
        JSON.stringify(validated.data),
        JSON.stringify(metadata),
        1, // Aggregate version (simplified for Phase 1)
        validated.causationId || null,
        validated.correlationId || null,
        validated.source,
        validated.timestamp instanceof Date ? validated.timestamp.toISOString() : validated.timestamp,
      ]);


      const eventRecord = this.mapRow(result.rows[0]);

      // Notify hooks (real-time broadcasting, etc.)
      // Fire and forget - don't block the response
      this.notifyHooks(eventRecord).catch(err => {
        // Log but don't throw - hooks failing shouldn't break event storage
        console.error('Event hook error:', err);
      });

      return eventRecord;
    } catch (error) {
      // Detailed error logging for debugging
      // Cast to any to access all possible error properties
      const err = error as any;
      console.error('❌ Event append failed:', {
        eventId: validated.id,
        eventType: validated.type,
        userId: validated.userId,
        aggregateId: validated.aggregateId,
        error: {
          name: err?.name || 'Unknown',
          message: err?.message || 'No message',
          code: err?.code,
          detail: err?.detail,
          hint: err?.hint,
          where: err?.where,
          schema: err?.schema,
          table: err?.table,
          column: err?.column,
          constraint: err?.constraint,
          stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
        }
      });

      // CRITICAL FIX: Throw proper Error object, not ErrorEvent
      const errorMessage = error instanceof Error 
        ? error.message 
        : err?.detail || err?.message || 'Failed to append event to store';
      
      throw new Error(`Failed to append event: ${errorMessage}`);
    }
  }
  
  /**
   * Infer aggregate type from event type
   * 
   * Examples:
   * - 'note.creation.requested' -> 'entity'
   * - 'task.completed' -> 'entity'
   * - 'user.created' -> 'user'
   */
  private inferAggregateType(eventType: string): string {
    if (eventType.startsWith('note.') || eventType.startsWith('task.') || eventType.startsWith('entity.')) {
      return 'entity';
    }
    if (eventType.startsWith('relation.')) {
      return 'relation';
    }
    if (eventType.startsWith('user.')) {
      return 'user';
    }
    return 'system';
  }

  /**
   * Append multiple events in a batch (atomic)
   * 
   * Phase 1: Validates all events before batch insert
   */
  async appendBatch(events: SynapEvent[]): Promise<EventRecord[]> {
    if (events.length === 0) {
      return [];
    }

    // Validate all events first
    const validated = events.map(event => SynapEventSchema.parse(event));

    // Build values for batch insert
    const values: unknown[] = [];
    const valuePlaceholders: string[] = [];
    
    validated.forEach((event, index) => {
      const baseIndex = index * 12;
      valuePlaceholders.push(
        `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, ` +
        `$${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, ` +
        `$${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12})`
      );
      
      const aggregateType = this.inferAggregateType(event.type);
      const metadata = {
        version: event.version,
        requestId: event.requestId,
      };
      
      values.push(
        event.id,
        event.aggregateId || event.id,
        aggregateType,
        event.type,
        event.userId,
        JSON.stringify(event.data),
        JSON.stringify(metadata),
        1, // Aggregate version
        event.causationId || null,
        event.correlationId || null,
        event.source,
        event.timestamp,
      );
    });

    const result = await this.query(`
      INSERT INTO events_timescale (
        id, aggregate_id, aggregate_type, event_type, user_id, data,
        metadata, version, causation_id, correlation_id, source, timestamp
      ) VALUES ${valuePlaceholders.join(', ')}
      RETURNING *
    `, values);

    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Get all events for an aggregate (event replay)
   */
  async getAggregateStream(
    aggregateId: string,
    options: EventStreamOptions = {}
  ): Promise<EventRecord[]> {
    const { fromVersion = 0, toVersion, eventTypes } = options;

    let query = `
      SELECT * FROM events_timescale
      WHERE aggregate_id = $1
        AND version > $2
    `;
    
    const params: unknown[] = [aggregateId, fromVersion];
    let paramIndex = 3;

    if (toVersion !== undefined) {
      query += ` AND version <= $${paramIndex}`;
      params.push(toVersion);
      paramIndex++;
    }

    if (eventTypes && eventTypes.length > 0) {
      query += ` AND event_type = ANY($${paramIndex})`;
      params.push(eventTypes);
      paramIndex++;
    }

    query += ` ORDER BY version ASC`;

    const result = await this.query(query, params);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Get current version of aggregate (for optimistic locking)
   */
  async getAggregateVersion(aggregateId: string): Promise<number | null> {
    const result = await this.query(`
      SELECT MAX(version) as version
      FROM events_timescale
      WHERE aggregate_id = $1
    `, [aggregateId]);

    return result.rows[0]?.version || null;
  }

  /**
   * Get events by user (time range)
   */
  async getUserStream(
    userId: string,
    options: UserStreamOptions = {}
  ): Promise<EventRecord[]> {
    const {
      days = 7,
      limit = 1000,
      eventTypes,
      aggregateTypes,
    } = options;

    let query = `
      SELECT * FROM events_timescale
      WHERE user_id = $1
        AND timestamp >= NOW() - ($2 || ' days')::INTERVAL
    `;
    
    const params: unknown[] = [userId, days];
    let paramIndex = 3;

    if (eventTypes && eventTypes.length > 0) {
      query += ` AND event_type = ANY($${paramIndex})`;
      params.push(eventTypes);
      paramIndex++;
    }

    if (aggregateTypes && aggregateTypes.length > 0) {
      query += ` AND aggregate_type = ANY($${paramIndex})`;
      params.push(aggregateTypes);
      paramIndex++;
    }

    query += ` ORDER BY timestamp DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.query(query, params);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Get events by correlation ID (workflow tracking)
   */
  async getCorrelatedEvents(correlationId: string): Promise<EventRecord[]> {
    const result = await this.query(`
      SELECT * FROM events_timescale
      WHERE correlation_id = $1
      ORDER BY timestamp ASC
    `, [correlationId]);

    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Get events by event type (for debugging/analytics)
   */
  async getEventsByType(
    eventType: string,
    limit: number = 100
  ): Promise<EventRecord[]> {
    const result = await this.query(`
      SELECT * FROM events_timescale
      WHERE event_type = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `, [eventType, limit]);

    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Search events with filters and pagination
   */
  async searchEvents(filters: {
    userId?: string;
    eventType?: string;
    aggregateType?: AggregateType;
    aggregateId?: string;
    correlationId?: string;
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
    offset?: number;
  } = {}): Promise<EventRecord[]> {
    let query = 'SELECT * FROM events_timescale WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(filters.userId);
      paramIndex++;
    }

    if (filters.eventType) {
      query += ` AND event_type = $${paramIndex}`;
      params.push(filters.eventType);
      paramIndex++;
    }

    if (filters.aggregateType) {
      query += ` AND aggregate_type = $${paramIndex}`;
      params.push(filters.aggregateType);
      paramIndex++;
    }

    if (filters.aggregateId) {
      query += ` AND aggregate_id = $${paramIndex}`;
      params.push(filters.aggregateId);
      paramIndex++;
    }

    if (filters.correlationId) {
      query += ` AND correlation_id = $${paramIndex}`;
      params.push(filters.correlationId);
      paramIndex++;
    }

    if (filters.fromDate) {
      query += ` AND timestamp >= $${paramIndex}`;
      params.push(filters.fromDate);
      paramIndex++;
    }

    if (filters.toDate) {
      query += ` AND timestamp <= $${paramIndex}`;
      params.push(filters.toDate);
      paramIndex++;
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(filters.limit);
      paramIndex++;
    }

    if (filters.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(filters.offset);
      paramIndex++;
    }

    const result = await this.query(query, params);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Count events (for analytics)
   */
  async countEvents(filters: {
    userId?: string;
    eventType?: string;
    aggregateType?: AggregateType;
    fromDate?: Date;
    toDate?: Date;
  } = {}): Promise<number> {
    let query = 'SELECT COUNT(*) as count FROM events_timescale WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(filters.userId);
      paramIndex++;
    }

    if (filters.eventType) {
      query += ` AND event_type = $${paramIndex}`;
      params.push(filters.eventType);
      paramIndex++;
    }

    if (filters.aggregateType) {
      query += ` AND aggregate_type = $${paramIndex}`;
      params.push(filters.aggregateType);
      paramIndex++;
    }

    if (filters.fromDate) {
      query += ` AND timestamp >= $${paramIndex}`;
      params.push(filters.fromDate);
      paramIndex++;
    }

    if (filters.toDate) {
      query += ` AND timestamp <= $${paramIndex}`;
      params.push(filters.toDate);
      paramIndex++;
    }

    const result = await this.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Map database row to EventRecord
   */
  private mapRow(row: Record<string, unknown>): EventRecord {
    return {
      id: row.id as string,
      timestamp: new Date(row.timestamp as string),
      aggregateId: row.aggregate_id as string,
      aggregateType: row.aggregate_type as string,
      eventType: row.event_type as string,
      userId: row.user_id as string,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : (row.data as Record<string, unknown>),
      metadata: row.metadata
        ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>))
        : undefined,
      version: row.version as number,
      causationId: row.causation_id as string | undefined,
      correlationId: row.correlation_id as string | undefined,
      source: row.source as string,
    };
  }
}

// ============================================================================
// SINGLETON EXPORT  
// ============================================================================

import { sql } from '../client-pg.js';

/**
 * Singleton EventRepository instance
 * Uses pure postgres.js for maximum simplicity and performance
 */
export const eventRepository = new EventRepository(sql);

/**
 * Get EventRepository instance (for compatibility)
 * @deprecated Use `eventRepository` directly instead
 */
export function getEventRepository(): EventRepository {
  return eventRepository;
}




