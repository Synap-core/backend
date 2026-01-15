/**
 * Base Repository Class
 * 
 * Provides common functionality for all repositories:
 * - Automatic event emission on DB writes
 * - Consistent error handling
 * - Type-safe operations
 */

import type { EventRepository } from './event-repository.js';

export interface RepositoryConfig {
  subjectType: string;
  // Optional override for plural name (defaults to subjectType + 's')
  pluralName?: string;
}

/**
 * Base class for all entity repositories
 * Handles automatic event emission for completed operations
 */
export abstract class BaseRepository<TEntity, TCreateInput, TUpdateInput> {
  constructor(
    protected db: any, // Drizzle DB instance
    protected eventRepo: EventRepository,
    protected config: RepositoryConfig,
  ) {}

  /**
   * Emit a completed event after successful DB operation
   */
  protected async emitCompleted(
    action: 'create' | 'update' | 'delete',
    data: Partial<TEntity> & { id: string },
    userId: string,
  ): Promise<void> {
    const plural = this.config.pluralName || `${this.config.subjectType}s`;
    const eventType = `${plural}.${action}.completed`;
    
    // Use EventRepository.append with correct SynapEvent schema
    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: 'v1',
      type: eventType,
      subjectId: data.id,
      subjectType: this.config.subjectType,
      data: data as Record<string, unknown>,
      userId,
      source: 'api',
      timestamp: new Date(),
      metadata: {},
    });
  }

  /**
   * Abstract methods to be implemented by concrete repositories
   */
  abstract create(data: TCreateInput, userId: string): Promise<TEntity>;
  abstract update(id: string, data: TUpdateInput, userId: string): Promise<TEntity>;
  abstract delete(id: string, userId: string): Promise<void>;
}
