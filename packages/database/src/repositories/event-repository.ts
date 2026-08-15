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

import type postgres from "postgres";
import { SynapEventSchema, type SynapEvent } from "@synap-core/core";

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

export type subjectType = string;
// export enum subjectType {
//   ENTITY = "entity",
//   RELATION = "relation",
//   USER = "user",
//   SYSTEM = "system",
// }

export enum EventSource {
  API = "api",
  AUTOMATION = "automation",
  SYNC = "sync",
  MIGRATION = "migration",
  SYSTEM = "system",
}

/**
 * EventRecord - Database representation of an event
 *
 * This is the format returned from the database.
 * It maps directly to the events table structure.
 */
export interface EventRecord {
  id: string;
  timestamp: Date;
  subjectId: string;
  subjectType: string;
  eventType: string;
  userId: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  version: number;
  causationId?: string;
  correlationId?: string;
  source: string;

  // ── Agent-run observability telemetry (0131) ──────────────────────────────
  // Populated from the events table's real columns. Undefined for events that
  // do not carry telemetry (the vast majority). cost is null when the provider
  // reported no price.
  isAgent?: boolean;
  agentUserId?: string;
  agentType?: string;
  model?: string;
  provider?: string;
  costUsd?: number | null;
  tokensIn?: number;
  tokensOut?: number;
  tokensTotal?: number;
  latencyMs?: number;
  toolCount?: number;
  runStatus?: string;
  finishReason?: string;

  // ── Workspace context (0223) ────────────────────────────────────────────────
  // Populated from the events table's real `workspace_id` column. Undefined for
  // pod-wide / hydration events and for rows written before the column existed.
  workspaceId?: string;

  // ── Governance linkage (0231) ───────────────────────────────────────────────
  // The proposal an AGENT write went through (auto-approved OR pending→approved).
  // Undefined when the write executed with no proposal — an "ungoverned AI write"
  // is `isAgent && proposalId == null` on the `.completed` event.
  proposalId?: string;
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
  subjectTypes?: subjectType[];
}

// ============================================================================
// EVENT REPOSITORY
// ============================================================================

/**
 * When `events.proposal_id` began recording (migration 0231). Rows older than
 * this carry NULL because the COLUMN did not exist, not because the write was
 * ungoverned — so the "ungoverned AI write" read floors here and states that
 * scope rather than indicting unmeasured history. Move this ONLY if the column
 * is ever re-instrumented; never widen it to claim coverage we do not have.
 */
export const UNGOVERNED_INSTRUMENTATION_EPOCH = new Date(
  "2026-08-05T00:00:00.000Z"
);

export class EventRepository {
  private eventHooks: EventHook[] = [];

  // Accept postgres.js Sql instance
  constructor(private sql: ReturnType<typeof postgres>) {}

  /**
   * Query wrapper for postgres.js
   * Converts .query(sqlString, params[]) to postgres.js template literal format
   * This maintains compatibility with existing query code
   */
  private async query(
    sqlString: string,
    params?: any[]
  ): Promise<{ rows: any[] }> {
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
    this.eventHooks = this.eventHooks.filter((h) => h !== hook);
  }

  /**
   * Notify all event hooks
   *
   * @param event - The event record to broadcast
   */
  private async notifyHooks(event: EventRecord): Promise<void> {
    // Fire all hooks in parallel
    await Promise.allSettled(
      this.eventHooks.map((hook) => Promise.resolve(hook(event)))
    );
  }

  /**
   * Get event by ID
   */
  async findById(id: string): Promise<EventRecord | null> {
    const result = await this.query(
      `
      SELECT * FROM events
      WHERE id = $1
    `,
      [id]
    );

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

    // Map SynapEvent to database structure
    // Use provided subjectType or infer from event type pattern
    const subjectType =
      validated.subjectType || this.infersubjectType(validated.type);

    // Store version and requestId in metadata
    const metadata = {
      version: validated.version,
      requestId: validated.requestId,
    };

    try {
      const result = await this.query(
        `
        INSERT INTO events (
          id,
          subject_id,
          subject_type,
          type,
          user_id,
          data,
          metadata,
          source,
          correlation_id,
          timestamp,
          is_agent,
          agent_user_id,
          agent_type,
          model,
          provider,
          cost_usd,
          tokens_in,
          tokens_out,
          tokens_total,
          latency_ms,
          tool_count,
          run_status,
          finish_reason,
          workspace_id,
          proposal_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
        )
        RETURNING *
      `,
        [
          validated.id,
          validated.subjectId || validated.id, // Use event ID as subject if not provided
          subjectType,
          validated.type,
          validated.userId,
          JSON.stringify(validated.data),
          JSON.stringify(metadata),
          validated.source,
          validated.correlationId || null,
          validated.timestamp instanceof Date
            ? validated.timestamp.toISOString()
            : validated.timestamp,
          // Agent-run observability telemetry (nullable; absent on most events)
          validated.isAgent ?? null,
          validated.agentUserId ?? null,
          validated.agentType ?? null,
          validated.model ?? null,
          validated.provider ?? null,
          validated.costUsd ?? null,
          validated.tokensIn ?? null,
          validated.tokensOut ?? null,
          validated.tokensTotal ?? null,
          validated.latencyMs ?? null,
          validated.toolCount ?? null,
          validated.runStatus ?? null,
          validated.finishReason ?? null,
          // Workspace context as a real column (0223). Nullable for pod-wide /
          // hydration events. Still folded into `data` by the writer for
          // back-compat, so readers COALESCE the two.
          validated.workspaceId ?? null,
          // Governance linkage (0231). The proposal an agent write went through;
          // null for a direct/ungoverned write or any human write.
          validated.proposalId ?? null,
        ]
      );

      const eventRecord = this.mapRow(result.rows[0]);

      // Notify hooks (real-time broadcasting, etc.)
      // Fire and forget - don't block the response
      this.notifyHooks(eventRecord).catch((err) => {
        // Log but don't throw - hooks failing shouldn't break event storage
        console.error("Event hook error:", err);
      });

      return eventRecord;
    } catch (error) {
      // Detailed error logging for debugging
      // Cast to any to access all possible error properties
      const err = error as Error & {
        code?: string;
        detail?: string;
        constraint?: string;
        table?: string;
        severity?: string;
        hint?: string;
        where?: string;
        schema?: string;
        column?: string;
      };
      console.error("❌ Event append failed:", {
        eventId: validated.id,
        eventType: validated.type,
        userId: validated.userId,
        subjectId: validated.subjectId,
        error: {
          name: err?.name || "Unknown",
          message: err?.message || "No message",
          code: err?.code,
          detail: err?.detail,
          hint: err?.hint,
          where: err?.where,
          schema: err?.schema,
          table: err?.table,
          column: err?.column,
          constraint: err?.constraint,
          stack: err?.stack?.split("\n").slice(0, 5).join("\n"),
        },
      });

      // CRITICAL FIX: Throw proper Error object, not ErrorEvent
      const errorMessage =
        error instanceof Error
          ? error.message
          : err?.detail || err?.message || "Failed to append event to store";

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
  private infersubjectType(eventType: string): string {
    if (
      eventType.startsWith("note.") ||
      eventType.startsWith("task.") ||
      eventType.startsWith("entity.")
    ) {
      return "entity";
    }
    if (eventType.startsWith("relation.")) {
      return "relation";
    }
    if (eventType.startsWith("user.")) {
      return "user";
    }
    return "system";
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
    const validated = events.map((event) => SynapEventSchema.parse(event));

    // Build values for batch insert
    const values: unknown[] = [];
    const valuePlaceholders: string[] = [];

    validated.forEach((event, index) => {
      const baseIndex = index * 10;
      valuePlaceholders.push(
        `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, ` +
          `$${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, ` +
          `$${baseIndex + 9}, $${baseIndex + 10})`
      );

      const subjectType =
        event.subjectType || this.infersubjectType(event.type);
      const metadata = {
        version: event.version,
        requestId: event.requestId,
      };

      values.push(
        event.id,
        event.subjectId || event.id,
        subjectType,
        event.type,
        event.userId,
        JSON.stringify(event.data),
        JSON.stringify(metadata),
        event.source,
        event.correlationId || null,
        event.timestamp
      );
    });

    const result = await this.query(
      `
      INSERT INTO events (
        id, subject_id, subject_type, type, user_id, data,
        metadata, source, correlation_id, timestamp
      ) VALUES ${valuePlaceholders.join(", ")}
      RETURNING *
    `,
      values
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Get all events for an aggregate (event replay)
   */
  async getAggregateStream(
    subjectId: string,
    options: EventStreamOptions = {}
  ): Promise<EventRecord[]> {
    const {
      fromVersion: _fromVersion,
      toVersion: _toVersion,
      eventTypes,
    } = options;

    let query = `
      SELECT * FROM events
      WHERE subject_id = $1
    `;

    const params: unknown[] = [subjectId];
    let paramIndex = 2;

    /* Version filtering temporarily disabled for simplified schema
    if (toVersion !== undefined) {
      query += ` AND version <= $${paramIndex}`;
      params.push(toVersion);
      paramIndex++;
    }
    */

    if (eventTypes && eventTypes.length > 0) {
      query += ` AND type = ANY($${paramIndex})`;
      params.push(eventTypes);
      paramIndex++;
    }

    query += ` ORDER BY timestamp ASC`;

    const result = await this.query(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Get current version of aggregate (for optimistic locking)
   */
  async getAggregateVersion(subjectId: string): Promise<number | null> {
    // Simplified version check using counting since we don't have version column in events table
    const result = await this.query(
      `
      SELECT COUNT(*) as version
      FROM events
      WHERE subject_id = $1
    `,
      [subjectId]
    );

    return parseInt(result.rows[0]?.version) || null;
  }

  /**
   * Get events by user (time range)
   */
  async getUserStream(
    userId: string,
    options: UserStreamOptions = {}
  ): Promise<EventRecord[]> {
    const { days = 7, limit = 1000, eventTypes, subjectTypes } = options;

    let query = `
      SELECT * FROM events
      WHERE user_id = $1
      AND timestamp >= NOW() - ($2 || ' days')::INTERVAL
    `;

    const params: unknown[] = [userId, days];
    let paramIndex = 3;

    if (eventTypes && eventTypes.length > 0) {
      query += ` AND type = ANY($${paramIndex})`;
      params.push(eventTypes);
      paramIndex++;
    }

    if (subjectTypes && subjectTypes.length > 0) {
      query += ` AND subject_type = ANY($${paramIndex})`;
      params.push(subjectTypes);
      paramIndex++;
    }

    query += ` ORDER BY timestamp DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.query(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Get events by correlation ID (workflow tracking).
   *
   * SECURITY: `correlation_id` is NOT unique per user — a single correlation id
   * can appear across multiple tenants' events. Callers MUST pass `userId` to
   * clamp the result to the owner's events; otherwise another user's events
   * (and their subjects/actors) leak into the result. The param is required.
   */
  async getCorrelatedEvents(
    correlationId: string,
    userId: string
  ): Promise<EventRecord[]> {
    // Select only the columns mapRow consumes (not SELECT * over a wide
    // JSONB-heavy hypertable) and cap the result so a pathological correlation
    // fan-out can't materialize an unbounded set.
    const result = await this.query(
      `
      SELECT id, timestamp, subject_id, subject_type, type, user_id,
             data, metadata, source, correlation_id,
             is_agent, agent_user_id, agent_type, model, provider, cost_usd,
             tokens_in, tokens_out, tokens_total, latency_ms, tool_count,
             run_status, finish_reason, workspace_id
      FROM events
      WHERE correlation_id = $1
      AND user_id = $2
      ORDER BY timestamp ASC
      LIMIT 1000
    `,
      [correlationId, userId]
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Batch-load correlated events for MANY correlation ids in a single query.
   *
   * Replaces the N+1 pattern of calling getCorrelatedEvents() once per row
   * (which exhausted the connection pool on a page of proposals). Loads every
   * correlated event for the page in ONE `correlation_id = ANY($1)` round-trip,
   * then the caller groups in memory.
   *
   * SECURITY: same tenancy clamp as getCorrelatedEvents — events are restricted
   * to `userId` so another tenant's events sharing a correlation id never leak.
   *
   * @param correlationIds - de-duplicated correlation ids for the page
   * @param userId - owner clamp (required)
   * @param limit - hard cap on rows returned across ALL ids (defense against a
   *   pathological correlation fan-out); default 2000 covers normal pages.
   * @returns flat list of EventRecord ordered by timestamp ASC; caller groups
   *   by correlationId.
   */
  async getCorrelatedEventsBatch(
    correlationIds: string[],
    userId: string,
    limit: number = 2000
  ): Promise<EventRecord[]> {
    if (correlationIds.length === 0) {
      return [];
    }

    // Select only the columns mapRow needs (avoids SELECT * over a wide,
    // JSONB-heavy hypertable). correlation_id is uuid[]; postgres.js casts the
    // string[] param via ::uuid[] so non-uuid ids are rejected loudly rather
    // than silently mismatching.
    const result = await this.query(
      `
      SELECT id, timestamp, subject_id, subject_type, type, user_id,
             data, metadata, source, correlation_id,
             is_agent, agent_user_id, agent_type, model, provider, cost_usd,
             tokens_in, tokens_out, tokens_total, latency_ms, tool_count,
             run_status, finish_reason, workspace_id
      FROM events
      WHERE correlation_id = ANY($1::uuid[])
      AND user_id = $2
      ORDER BY timestamp ASC
      LIMIT $3
    `,
      [correlationIds, userId, limit]
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Get events by event type (for debugging/analytics)
   */
  async getEventsByType(
    eventType: string,
    limit: number = 100
  ): Promise<EventRecord[]> {
    const result = await this.query(
      `
      SELECT * FROM events
      WHERE type = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `,
      [eventType, limit]
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Search events with filters and pagination
   */
  async searchEvents(
    filters: {
      userId?: string;
      eventType?: string;
      subjectType?: subjectType;
      subjectTypes?: string[];
      subjectId?: string;
      /**
       * Filter to events whose subject is in a SET (e.g. a campaign's member
       * entities). Unioned with `subjectId` — see the WHERE-clause build below.
       */
      subjectIds?: string[];
      correlationId?: string;
      workspaceId?: string;
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
      /** Filter by the action verb (middle segment of type, e.g. "create", "update"). */
      actions?: string[];
      /**
       * Filter to the events one AGENT produced (`events.agent_user_id`, a text
       * column matching `users.id`). The dedicated `events_agent_user_id_idx`
       * index has existed since 0131 with no reader — this is the reader: "show
       * me everything this agent did".
       *
       * NOT the same as the `agentUserId` on the EventRecord read model above —
       * that is output telemetry; this is an input predicate.
       */
      agentUserId?: string;
      /**
       * Filter to agent-produced events (`is_agent = true`) or explicitly to
       * human-produced ones (`is_agent` false/NULL — historical rows predate the
       * column, so `false` must include NULL or it silently hides them).
       */
      isAgent?: boolean;
      /**
       * The "ungoverned AI write" blind spot (0231): agent writes that EXECUTED
       * without ever going through a proposal — `is_agent = true AND proposal_id
       * IS NULL`, restricted to the executed-write event (`.completed`) so the
       * pre-gate `.requested` intent events (which never carry a proposal_id)
       * are not counted. A governed agent write (auto-approved OR pending→
       * approved) carries the proposal id and is excluded; a proposed-but-pending
       * write emits no `.completed` and is naturally excluded too. Combine with
       * `agentUserId` to scope to one agent. Backed by `idx_events_ungoverned_agent`.
       */
      ungoverned?: boolean;
    } = {}
  ): Promise<EventRecord[]> {
    let query = "SELECT * FROM events WHERE 1=1";
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(filters.userId);
      paramIndex++;
    }

    if (filters.workspaceId) {
      // Workspace context lives in the real `workspace_id` column (0223) but
      // historical / un-backfilled / compressed rows may only carry it in the
      // `data` JSONB — COALESCE resolves both.
      query += ` AND COALESCE(workspace_id, data->>'workspaceId') = $${paramIndex}`;
      params.push(filters.workspaceId);
      paramIndex++;
    }

    if (filters.eventType) {
      query += ` AND type = $${paramIndex}`;
      params.push(filters.eventType);
      paramIndex++;
    }

    if (filters.subjectType) {
      query += ` AND subject_type = $${paramIndex}`;
      params.push(filters.subjectType);
      paramIndex++;
    }

    if (filters.subjectTypes && filters.subjectTypes.length > 0) {
      const placeholders = filters.subjectTypes
        .map(() => `$${paramIndex++}`)
        .join(", ");
      query += ` AND subject_type IN (${placeholders})`;
      params.push(...filters.subjectTypes);
    }

    // Subject filter: singular `subjectId` and set `subjectIds` are UNIONED
    // into one membership predicate (ANDing them separately would intersect,
    // which is a footgun). This is ANDed with the user_id / workspace clamp
    // above, so it narrows visibility and never widens it.
    const subjectIdSet = new Set<string>();
    if (filters.subjectId) subjectIdSet.add(filters.subjectId);
    if (filters.subjectIds) {
      for (const s of filters.subjectIds) subjectIdSet.add(s);
    }
    if (subjectIdSet.size === 1) {
      query += ` AND subject_id = $${paramIndex}`;
      params.push([...subjectIdSet][0]);
      paramIndex++;
    } else if (subjectIdSet.size > 1) {
      const ids = [...subjectIdSet];
      const placeholders = ids.map(() => `$${paramIndex++}`).join(", ");
      query += ` AND subject_id IN (${placeholders})`;
      params.push(...ids);
    }

    if (filters.correlationId) {
      query += ` AND correlation_id = $${paramIndex}`;
      params.push(filters.correlationId);
      paramIndex++;
    }

    if (filters.agentUserId) {
      // `agent_user_id` is TEXT (users.id is a Kratos identity id, not a uuid) —
      // no cast, so a malformed value simply matches nothing instead of making
      // Postgres throw.
      query += ` AND agent_user_id = $${paramIndex}`;
      params.push(filters.agentUserId);
      paramIndex++;
    }

    if (filters.isAgent !== undefined) {
      // `false` must also match NULL: rows written before 0131 carry no
      // is_agent, and they are human-produced — excluding them would silently
      // truncate the human feed.
      query += filters.isAgent
        ? ` AND is_agent = true`
        : ` AND COALESCE(is_agent, false) = false`;
    }

    if (filters.actions && filters.actions.length > 0) {
      const placeholders = filters.actions
        .map(() => `$${paramIndex++}`)
        .join(", ");
      query += ` AND split_part(type, '.', 2) IN (${placeholders})`;
      params.push(...filters.actions);
    }

    if (filters.ungoverned) {
      // "Ungoverned AI write": an agent write that EXECUTED (`.completed`) with
      // no proposal behind it. `.requested` intent events are excluded — they
      // fire before the governance gate and never carry a proposal_id, so they
      // would otherwise be constant false positives.
      //
      // EPOCH FLOOR (dogfood finding 2026-08-11): every row written BEFORE
      // migration 0231 has `proposal_id IS NULL` because the column did not yet
      // exist — not because the write was ungoverned. Without this floor the
      // lane reports every historical agent write as "ran without any rule"
      // (on the first real pod: 17 such rows, all pre-migration, vs 0 genuine
      // ones after). An instrument cannot testify about the time before it
      // existed, so we scope the claim to the instrumented window instead of
      // fabricating a verdict about unmeasured history.
      query +=
        " AND is_agent = true AND proposal_id IS NULL AND type LIKE '%.completed'" +
        ` AND timestamp >= $${paramIndex}`;
      params.push(UNGOVERNED_INSTRUMENTATION_EPOCH.toISOString());
      paramIndex++;
    }

    if (filters.fromDate) {
      query += ` AND timestamp >= $${paramIndex}`;
      params.push(filters.fromDate.toISOString());
      paramIndex++;
    }

    if (filters.toDate) {
      query += ` AND timestamp <= $${paramIndex}`;
      params.push(filters.toDate.toISOString());
      paramIndex++;
    }

    query += " ORDER BY timestamp DESC";

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
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * List completed agent runs from the event log.
   *
   * Agent runs are persisted as `agentRun.create.completed` events (see
   * POST /api/hub/agent-runs) with first-class telemetry columns. This is the
   * read counterpart: a USER-scoped list, newest first, with optional
   * workspace narrowing (workspace context lives in data->>'workspaceId').
   *
   * SECURITY: `userId` is required and always clamps the result to the owner —
   * never expose another tenant's runs. Mirrors searchEvents' filter/order
   * style and reuses mapRow so every telemetry column comes back populated.
   *
   * @param filters.userId      owner clamp (required)
   * @param filters.workspaceId optional workspace narrowing
   * @param filters.limit       default 50
   * @param filters.cursor      timestamp keyset cursor — return runs strictly
   *                            older than this ISO timestamp (for pagination)
   */
  async listAgentRuns(filters: {
    userId: string;
    workspaceId?: string;
    limit?: number;
    cursor?: Date;
  }): Promise<EventRecord[]> {
    let query = `
      SELECT id, timestamp, subject_id, subject_type, type, user_id,
             data, metadata, source, correlation_id,
             is_agent, agent_user_id, agent_type, model, provider, cost_usd,
             tokens_in, tokens_out, tokens_total, latency_ms, tool_count,
             run_status, finish_reason, workspace_id
      FROM events
      WHERE type = 'agentRun.create.completed'
      AND user_id = $1
    `;
    const params: unknown[] = [filters.userId];
    let paramIndex = 2;

    if (filters.workspaceId) {
      // Real column (0223) with JSONB fallback for un-backfilled rows.
      query += ` AND COALESCE(workspace_id, data->>'workspaceId') = $${paramIndex}`;
      params.push(filters.workspaceId);
      paramIndex++;
    }

    if (filters.cursor) {
      query += ` AND timestamp < $${paramIndex}`;
      params.push(filters.cursor.toISOString());
      paramIndex++;
    }

    query += ` ORDER BY timestamp DESC LIMIT $${paramIndex}`;
    params.push(filters.limit ?? 50);

    const result = await this.query(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Count events (for analytics)
   */
  async countEvents(
    filters: {
      userId?: string;
      eventType?: string;
      subjectType?: subjectType;
      workspaceId?: string;
      fromDate?: Date;
      toDate?: Date;
    } = {}
  ): Promise<number> {
    let query = "SELECT COUNT(*) as count FROM events WHERE 1=1";
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(filters.userId);
      paramIndex++;
    }

    if (filters.workspaceId) {
      // Real column (0223) with JSONB fallback for un-backfilled rows.
      query += ` AND COALESCE(workspace_id, data->>'workspaceId') = $${paramIndex}`;
      params.push(filters.workspaceId);
      paramIndex++;
    }

    if (filters.eventType) {
      query += ` AND type = $${paramIndex}`;
      params.push(filters.eventType);
      paramIndex++;
    }

    if (filters.subjectType) {
      query += ` AND subject_type = $${paramIndex}`;
      params.push(filters.subjectType);
      paramIndex++;
    }

    if (filters.fromDate) {
      query += ` AND timestamp >= $${paramIndex}`;
      params.push(filters.fromDate.toISOString());
      paramIndex++;
    }

    if (filters.toDate) {
      query += ` AND timestamp <= $${paramIndex}`;
      params.push(filters.toDate.toISOString());
      paramIndex++;
    }

    const result = await this.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Windowed activity counts for the Activity plane's pulse band.
   *
   * A REAL SQL aggregate (`count(*) FILTER`) over the SAME events population the
   * Activity feed (`subscriptions.listAll` → `searchEvents`) renders — NOT a
   * capped fetch-then-count — so the band's numbers describe the feed the user
   * actually sees. One indexed pass; the `today` counts are FILTER subsets of
   * the same scan the `last7d` window bounds.
   *
   * POPULATION MATCH (no drift with the feed rows):
   *  - user-scoped via `user_id` (the events convention — the table has no
   *    direct workspace FK; workspace context is
   *    `COALESCE(workspace_id, data->>'workspaceId')`, same 3-state filter as
   *    `searchEvents`/`listAll`).
   *  - EXCLUDES pending-proposal events exactly as the feed does: a `.requested`
   *    event whose linked proposal (joined by `correlation_id`) is still
   *    `pending`. The feed is FACTS only, so the band must be too.
   *
   * CATEGORY DERIVATION mirrors the router's row mappers 1:1 (see
   * `routers/subscriptions.ts`):
   *  - `fromAgents` ← `deriveActorAI`: source/data-based AI attribution. It does
   *    NOT read the `is_agent` telemetry column — the feed's `actorAI` never
   *    does either, so keying off `is_agent` here would drift the band from the
   *    rows.
   *  - `leftPod`    ← `EXTERNAL_REACTION_KINDS` via `reactionKindForEventType`:
   *    `webhook.*` OR (`message.*` containing "out").
   *  - `needsLook`  ← `isFailedEvent`: type ending in ".failed".
   *
   * Timezone: `todaySince` is the caller's start-of-day boundary (the router
   * passes `startOfUtcDay()` — UTC, consistent with the rest of the pod's
   * "today" reads). The exact instants are returned to the caller as `sinceIso`
   * so the band can scope-label each number honestly.
   */
  async activityStats(params: {
    userId: string;
    /** 3-state: string = that ws, null = pod-wide only, undefined = no filter. */
    workspaceId?: string | null;
    todaySince: Date;
    weekSince: Date;
  }): Promise<{
    today: {
      total: number;
      fromAgents: number;
      leftPod: number;
      needsLook: number;
    };
    last7d: {
      total: number;
      fromAgents: number;
      leftPod: number;
      needsLook: number;
    };
  }> {
    const p: unknown[] = [params.userId];
    let paramIndex = 2;

    // 3-state workspace clamp (mirrors searchEvents' COALESCE resolution).
    let wsClause = "";
    if (typeof params.workspaceId === "string") {
      wsClause = ` AND COALESCE(workspace_id, data->>'workspaceId') = $${paramIndex}`;
      p.push(params.workspaceId);
      paramIndex++;
    } else if (params.workspaceId === null) {
      wsClause = ` AND COALESCE(workspace_id, data->>'workspaceId') IS NULL`;
    }

    const weekIdx = paramIndex;
    p.push(params.weekSince.toISOString());
    paramIndex++;
    const todayIdx = paramIndex;
    p.push(params.todaySince.toISOString());
    paramIndex++;

    // ── SQL translations of the router's TS category mappers (keep in sync) ──
    // deriveActorAI: source/data AI attribution. NULLIF('') matches JS truthiness
    // for the data hints (an empty string is not an AI signal).
    const AGENT = `(
      lower(source) IN ('automation','intelligence','ai','agent')
      OR NULLIF(data->>'agentUserId','') IS NOT NULL
      OR NULLIF(data->>'agentType','') IS NOT NULL
      OR lower(data->>'source') IN ('ai','agent','intelligence')
    )`;
    // EXTERNAL_REACTION_KINDS via reactionKindForEventType: webhook + message-out.
    const EXTERNAL = `(
      type LIKE 'webhook.%'
      OR (type LIKE 'message.%' AND type LIKE '%out%')
    )`;
    // isFailedEvent.
    const FAILED = `(type LIKE '%.failed')`;

    const today = `timestamp >= $${todayIdx}`;
    const week = `timestamp >= $${weekIdx}`;

    // Pending-proposal exclusion — the exact complement of the decision queue,
    // matching the feed's `e.pending` exclusion. A `.requested` event is dropped
    // only when its correlation still has an open (pending) proposal.
    const notPending = `NOT (
      type LIKE '%.requested'
      AND correlation_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM proposals prop
        WHERE prop.correlation_id = e.correlation_id
          AND prop.status = 'pending'
      )
    )`;

    const query = `
      SELECT
        count(*) FILTER (WHERE ${today})                 AS today_total,
        count(*) FILTER (WHERE ${today} AND ${AGENT})    AS today_agents,
        count(*) FILTER (WHERE ${today} AND ${EXTERNAL}) AS today_left,
        count(*) FILTER (WHERE ${today} AND ${FAILED})   AS today_look,
        count(*) FILTER (WHERE ${week})                  AS week_total,
        count(*) FILTER (WHERE ${week} AND ${AGENT})     AS week_agents,
        count(*) FILTER (WHERE ${week} AND ${EXTERNAL})  AS week_left,
        count(*) FILTER (WHERE ${week} AND ${FAILED})    AS week_look
      FROM events e
      WHERE user_id = $1${wsClause}
        AND ${week}
        AND ${notPending}
    `;

    const result = await this.query(query, p);
    const r = (result.rows[0] ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number => parseInt(String(v ?? 0), 10) || 0;
    return {
      today: {
        total: n(r.today_total),
        fromAgents: n(r.today_agents),
        leftPod: n(r.today_left),
        needsLook: n(r.today_look),
      },
      last7d: {
        total: n(r.week_total),
        fromAgents: n(r.week_agents),
        leftPod: n(r.week_left),
        needsLook: n(r.week_look),
      },
    };
  }

  /**
   * Map database row to EventRecord
   */
  private mapRow(row: Record<string, unknown>): EventRecord {
    return {
      id: row.id as string,
      timestamp: new Date(row.timestamp as string),
      subjectId: row.subject_id as string,
      subjectType: row.subject_type as string,
      eventType: row.type as string,
      userId: row.user_id as string,
      data:
        typeof row.data === "string"
          ? JSON.parse(row.data)
          : (row.data as Record<string, unknown>),
      metadata: row.metadata
        ? typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : (row.metadata as Record<string, unknown>)
        : undefined,
      version: 1, // Simplified versioning
      causationId: row.causation_id as string | undefined,
      correlationId: row.correlation_id as string | undefined,
      source: row.source as string,
      // Agent-run observability telemetry. Columns may be absent on rows
      // selected before the migration ran, or on older pods — coalesce to
      // undefined so existing readers never break. numeric(cost_usd) comes back
      // as a string from postgres.js → parse to a number (null stays null).
      isAgent:
        row.is_agent === undefined || row.is_agent === null
          ? undefined
          : (row.is_agent as boolean),
      agentUserId: (row.agent_user_id as string | null) ?? undefined,
      agentType: (row.agent_type as string | null) ?? undefined,
      model: (row.model as string | null) ?? undefined,
      provider: (row.provider as string | null) ?? undefined,
      costUsd:
        row.cost_usd === null
          ? null
          : row.cost_usd === undefined
            ? undefined
            : Number(row.cost_usd),
      tokensIn: (row.tokens_in as number | null) ?? undefined,
      tokensOut: (row.tokens_out as number | null) ?? undefined,
      tokensTotal: (row.tokens_total as number | null) ?? undefined,
      latencyMs: (row.latency_ms as number | null) ?? undefined,
      toolCount: (row.tool_count as number | null) ?? undefined,
      runStatus: (row.run_status as string | null) ?? undefined,
      finishReason: (row.finish_reason as string | null) ?? undefined,
      // Workspace context real column (0223). Absent on pre-migration rows.
      workspaceId: (row.workspace_id as string | null) ?? undefined,
      // Governance linkage real column (0231). Absent on pre-migration rows.
      proposalId: (row.proposal_id as string | null) ?? undefined,
    };
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

import { sql } from "../client-pg.js";

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
