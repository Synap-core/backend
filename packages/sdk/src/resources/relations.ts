/**
 * Relations API - Universal Relationship Management
 * 
 * ALL MUTATIONS are event-sourced (go through events.log)
 * ALL QUERIES are direct reads (fast)
 */

import type { SynapClient } from '@synap-core/client';
import type { RelationType, Relation, RelationFilter } from '../types/relations.js';
import { randomUUID } from 'node:crypto';

/**
 * Relations API
 * 
 * @example
 * ```typescript
 * // Create relationship (event-sourced)
 * await sdk.relations.create(taskId, personId, 'assigned_to');
 * 
 * // Get relations (direct read)
 * const relations = await sdk.relations.get(entityId, {
 *   type: 'assigned_to',
 *   direction: 'both'
 * });
 * 
 * // Get related entities (direct read)
 * const people = await sdk.relations.getRelated(taskId, {
 *   type: 'assigned_to',
 *   direction: 'source'
 * });
 * ```
 */
export class RelationsAPI {
  constructor(private readonly client: SynapClient) {}

  /**
   * Create relationship (event-sourced)
   * 
   * Publishes `relations.create.requested` event → relationsWorker → DB
   * 
   * @param sourceId - Source entity ID
   * @param targetId - Target entity ID
   * @param type - Relationship type
   * @param metadata - Optional metadata
   */
  async create(
    sourceId: string,
    targetId: string,
    type: RelationType | string,
    metadata?: Record<string, unknown>
  ): Promise<{ relationId: string }> {
    const relationId = randomUUID();

    await this.client.events.log.mutate({
      aggregateId: relationId,
      aggregateType: 'relation',
      eventType: 'relations.create.requested',
      data: {
        id: relationId,
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        type,
        metadata,
      },
      metadata: {},
      version: 1,
      source: 'api',
    });

    return { relationId };
  }

  /**
   * Delete relationship (event-sourced)
   * 
   * Publishes `relations.delete.requested` event → relationsWorker → DB
   */
  async delete(relationId: string): Promise<{ success: boolean }> {
    await this.client.events.log.mutate({
      aggregateId: relationId,
      aggregateType: 'relation',
      eventType: 'relations.delete.requested',
      data: {
        relationId,
      },
      metadata: {},
      version: 1,
      source: 'api',
    });

    return { success: true };
  }

  /**
   * Get relations for an entity (direct read)
   * 
   * Returns relationship records (not the related entities themselves)
   */
  async get(
    entityId: string,
    options: Omit<RelationFilter, 'entityId'> = {}
  ): Promise<Relation[]> {
    // Type assertion needed because relations router not in AppRouter type yet
    const result = await (this.client as any).relations.get.query({
      entityId,
      type: options.type,
      direction: options.direction || 'both',
      limit: options.limit || 50,
    });
    
    return result.relations as Relation[];
  }

  /**
   * Get related entities (direct read with join)
   * 
   * Returns the actual entity objects that are related
   */
  async getRelated(
    entityId: string,
    options: Omit<RelationFilter, 'entityId'> = {}
  ) {
    // Type assertion needed because relations router not in AppRouter type yet  
    const result = await (this.client as any).relations.getRelated.query({
      entityId,
      type: options.type,
      direction: options.direction || 'both',
      limit: options.limit || 50,
    });
    
    return result.entities;
  }

  /**
   * Get relation statistics for an entity (direct read)
   */
  async getStats(entityId: string) {
    // Type assertion needed because relations router not in AppRouter type yet
    const result = await (this.client as any).relations.getStats.query({ entityId });
    return result;
  }
}
