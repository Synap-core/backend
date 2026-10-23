/**
 * Base Repository Class
 *
 * Provides common functionality for all repositories:
 * - Automatic event emission on DB writes
 * - Consistent error handling
 * - Type-safe operations
 */

import type { EventRepository } from "./event-repository.js";
import type {
  EventAction,
  SubjectType,
} from "../utils/create-unified-event.js";
import { createUnifiedEvent } from "../utils/create-unified-event.js";
import { unifiedEventToSynapEvent } from "../utils/unified-event-to-synap-event.js";

export interface RepositoryConfig {
  subjectType: SubjectType | string;
  // Optional override for plural name (defaults to subjectType + 's')
  pluralName?: string;
}

/**
 * Base class for all entity repositories
 * Handles automatic event emission for completed operations
 * Uses UnifiedEvent system for type safety
 */
export abstract class BaseRepository<TEntity, TCreateInput, TUpdateInput> {
  constructor(
    protected db: any, // Drizzle DB instance
    protected eventRepo: EventRepository,
    protected config: RepositoryConfig
  ) {}

  /**
   * Emit a completed event after successful DB operation
   * Uses UnifiedEvent system for type safety
   */
  protected async emitCompleted(
    action: EventAction,
    data: Partial<TEntity> & { id: string },
    userId: string
  ): Promise<void> {
    const subjectType = this.config.subjectType as SubjectType;

    // Create unified event using the new system
    const unifiedEvent = createUnifiedEvent({
      subjectType,
      action,
      phase: "completed",
      subjectId: data.id,
      data: data as Record<string, unknown>,
      userId,
      source: "api",
    });

    // Convert to SynapEvent format for database storage
    const synapEvent = unifiedEventToSynapEvent(unifiedEvent);

    // Store in event repository (database).
    //
    // ⚠️ THIS APPEND IS LOAD-BEARING — DO NOT REMOVE IT. It is not merely a
    // history row. When the repository was constructed with the module-level
    // `eventRepository` SINGLETON (as every realtime-relevant call site is
    // required to do — see the `realtime-event-hooks` tripwire in
    // packages/api), `append()` runs `notifyHooks()`, which is the ONLY path
    // to the four hooks registered once at startup by
    // `setupEventBroadcasting()` (packages/api/src/setup-event-broadcasting.ts):
    //   1. SSE broadcast          → eventStreamManager (Hub /api/hub/events/stream)
    //   2. Domain → Socket.IO     → emitDomainEventToRealtime (live UI updates)
    //   3. Materialization        → `.validated` only; not this path
    //   4. Real-time sync push    → syncRealtimeHook (cross-pod peer sync)
    //
    // This is the FACT bus, and it is deliberately SEPARATE from the automation
    // fan-out. `recordDomainMutation()` / `auditLog()` (packages/api/src/utils/)
    // construct a FRESH, hookless `new EventRepository(sql)` for every non-
    // `validated` phase precisely so they do NOT double-fire these hooks — see
    // the comment at audit-log.ts, which names "the repositories" as the half
    // that drives broadcast/sync. Removing this append therefore does not move
    // the work elsewhere; it silently deletes realtime, SSE and peer sync.
    //
    // Concretely: `workspaces.update.completed` (emitted here, plural — the
    // live door writes singular `workspace.*`) is the SOLE producer of the
    // `workspace:updated` Socket.IO event mapped at domain-event-bridge.ts.
    // `view.*`, `document.*` and `entity_facet.*` are likewise mapped there and
    // have NO `recordDomainMutation` door at all — this append is their only
    // producer.
    //
    // A previous version of this comment claimed Inngest workers consumed these
    // rows. Inngest was removed (see packages/jobs/src/workers/side-effects.ts);
    // that claim was stale and reads as though the append were dead. It is not.
    // Locked by `__tests__/base-repository-emit-hooks.test.ts`.
    await this.eventRepo.append(synapEvent);
  }

  /**
   * Abstract methods to be implemented by concrete repositories
   */
  abstract create(data: TCreateInput, userId: string): Promise<TEntity>;
  abstract update(
    id: string,
    data: TUpdateInput,
    userId: string
  ): Promise<TEntity>;
  abstract delete(id: string, userId: string): Promise<void>;
}
