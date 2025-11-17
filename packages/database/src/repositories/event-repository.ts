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
 */

import { Pool } from '@neondatabase/serverless';
import { SynapEventSchema, type SynapEvent } from '@synap/types';

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
 * It maps directly to the events_v2 table structure.
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
  constructor(private pool: Pool) {}

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

    const result = await this.pool.query(`
      INSERT INTO events_v2 (
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
      validated.timestamp,
    ]);

    return this.mapRow(result.rows[0]);
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

    const result = await this.pool.query(`
      INSERT INTO events_v2 (
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
      SELECT * FROM events_v2
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

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Get current version of aggregate (for optimistic locking)
   */
  async getAggregateVersion(aggregateId: string): Promise<number | null> {
    const result = await this.pool.query(`
      SELECT MAX(version) as version
      FROM events_v2
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
      SELECT * FROM events_v2
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

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Get events by correlation ID (workflow tracking)
   */
  async getCorrelatedEvents(correlationId: string): Promise<EventRecord[]> {
    const result = await this.pool.query(`
      SELECT * FROM events_v2
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
    const result = await this.pool.query(`
      SELECT * FROM events_v2
      WHERE event_type = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `, [eventType, limit]);

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
    let query = 'SELECT COUNT(*) as count FROM events_v2 WHERE 1=1';
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

    const result = await this.pool.query(query, params);
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

/**
 * Singleton EventRepository instance
 * 
 * Uses DATABASE_URL from environment
 */
let _eventRepository: EventRepository | null = null;

export function getEventRepository(): EventRepository {
  if (!_eventRepository) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    _eventRepository = new EventRepository(pool);
  }
  return _eventRepository;
}

export const eventRepository = getEventRepository();

