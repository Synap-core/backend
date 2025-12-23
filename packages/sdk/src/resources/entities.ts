/**
 * Entities API - Generic Entity Operations
 * 
 * ALL MUTATIONS are event-sourced (go through events.log)
 * ALL QUERIES are direct reads (fast)
 */

import type { SynapClient } from '@synap/client';
import type { EntityType } from '@synap/types/entities';
import { randomUUID } from 'node:crypto';

export interface CreateEntityInput<T extends EntityType = EntityType> {
  type: T;
  title: string;
  preview?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateEntityInput {
  title?: string;
  preview?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ListEntitiesOptions {
  type?: EntityType;
  limit?: number;
}

export interface SearchOptions {
  query: string;
  types?: EntityType[];
  limit?: number;
}

/**
 * Entities API
 * 
 * @example
 * ```typescript
 * // Create task (event-sourced)
 * const task = await sdk.entities.create({
 *   type: 'task',
 *   title: 'Call Marie',
 *   metadata: { dueDate: '2024-12-20', priority: 'high' }
 * });
 * 
 * // Get entity (direct read)
 * const entity = await sdk.entities.get(task.id);
 * 
 * // List entities (direct read)
 * const tasks = await sdk.entities.list({ type: 'task' });
 * ```
 */
export class EntitiesAPI {
  constructor(private readonly client: SynapClient) {}

  /**
   * Create entity (event-sourced)
   * 
   * Publishes `entities.create.requested` event → entitiesWorker → DB
   */
  async create<T extends EntityType>(input: CreateEntityInput<T>): Promise<{ entityId: string }> {
    const entityId = randomUUID();

    // Call events.log to publish create event
    await this.client.events.log.mutate({
      aggregateId: entityId,
      aggregateType: 'entity',
      eventType: 'entities.create.requested',
      data: {
        id: entityId,
        entityType: input.type,
        title: input.title,
        preview: input.preview,
        content: input.content,
        metadata: input.metadata,
      },
      metadata: {},
      version: 1,
      source: 'api',
    });

    return { entityId };
  }

  /**
   * Update entity (event-sourced)
   * 
   * Publishes `entities.update.requested` event → entitiesWorker → DB
   */
  async update(id: string, input: UpdateEntityInput): Promise<{ success: boolean }> {
    await this.client.events.log.mutate({
      aggregateId: id,
      aggregateType: 'entity',
      eventType: 'entities.update.requested',
      data: {
        entityId: id,
        ...input,
      },
      metadata: {},
      version: 1, // TODO: Get actual version
      source: 'api',
    });

    return { success: true };
  }

  /**
   * Delete entity (event-sourced soft delete)
   * 
   * Publishes `entities.delete.requested` event → entitiesWorker → DB
   */
  async delete(id: string): Promise<{ success: boolean }> {
    await this.client.events.log.mutate({
      aggregateId: id,
      aggregateType: 'entity',
      eventType: 'entities.delete.requested',
      data: {
        entityId: id,
      },
      metadata: {},
      version: 1,
      source: 'api',
    });

    return { success: true };
  }

  /**
   * Get entity by ID (direct read)
   */
  async get(id: string) {
    const result = await this.client.entities.get.query({ id });
    return result.entity;
  }

  /**
   * List entities (direct read)
   */
  async list(options: ListEntitiesOptions = {}) {
    const result = await this.client.entities.list.query({
      type: options.type as any, // Type cast because router has different enum
      limit: options.limit || 50,
    });
    return result.entities;
  }

  /**
   * Search entities (direct read)
   */
  async search(options: SearchOptions) {
    const result = await this.client.entities.search.query({
      query: options.query,
      type: options.types?.[0] as any, // Type cast because router has different enum
      limit: options.limit || 10,
    });
    return result.entities;
  }
}
