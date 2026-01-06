/**
 * Events API - Event History and Replay
 * 
 * ALL OPERATIONS are direct reads (query event log)
 */

import type { SynapClient } from '@synap-core/client';
import type { Event, EventFilter } from '../types/events.js';

/**
 * Events API
 * 
 * @example
 * ```typescript
 * // Get event history for an entity
 * const history = await sdk.events.getHistory(taskId);
 * 
 * // Get user's event timeline
 * const timeline = await sdk.events.getTimeline({
 *   limit: 100,
 *   after: new Date('2024-01-01')
 * });
 * 
 * // Filter by event types
 * const creates = await sdk.events.getHistory(entityId, {
 *   eventTypes: ['entities.create.validated', 'entities.update.validated']
 * });
 * ```
 */
export class EventsAPI {
  constructor(private readonly client: SynapClient) {}

  /**
   * Get event history for a specific subject (entity, relation, etc.)
   * 
   * Returns all events related to the subject in chronological order
   */
  async getHistory(
    subjectId: string,
    options: Omit<EventFilter, 'subjectId'> = {}
  ): Promise<Event[]> {
    const events = await this.client.events.list.query({
      // Note: The current events.list doesn't support subjectId filter
      // For now, we'll get all events and filter client-side
      // TODO: Enhance events.list router to support subjectId
      limit: options.limit || 50,
      type: options.eventTypes?.[0], // Current API only supports single type
    });

    // Client-side filter by subjectId
    // TODO: Move this to server-side once router enhanced
    // Type cast to any because Event shape from router doesn't match our SDK Event type
    return events.filter((event: any) => 
      event.data?.entityId === subjectId || 
      event.data?.relationId === subjectId ||
      event.data?.subjectId === subjectId
    ) as any[];
  }

  /**
   * Get user's complete event timeline
   * 
   * Returns all events for the current user
   */
  async getTimeline(options: EventFilter = {}): Promise<Event[]> {
    const events = await this.client.events.list.query({
      limit: options.limit || 50,
      type: options.eventTypes?.[0],
    });

    return events as any[];
  }

  /**
   * Replay events to rebuild entity state
   * 
   * Note: This is a client-side replay for now.
   * For production, server-side projector rebuild is recommended.
   */
  async replay(subjectId: string): Promise<any> {
    const events = await this.getHistory(subjectId);
    
    // Simple event replay (can be enhanced)
    let state: any = {};
    
    for (const event of events) {
      switch (event.type) {
        case 'entity.created':
        case 'entities.create.validated':
          state = { ...event.data };
          break;
        case 'entity.updated':
        case 'entities.update.validated':
          state = { ...state, ...event.data };
          break;
        case 'entity.deleted':
        case 'entities.delete.validated':
          state.deletedAt = event.timestamp;
          break;
      }
    }
    
    return state;
  }
}
