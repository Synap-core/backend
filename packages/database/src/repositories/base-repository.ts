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

    // Store in event repository (database)
    // Note: Inngest workers will pick up completed events from the database
    // via event hooks or polling - we don't send directly to avoid circular dependency
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
