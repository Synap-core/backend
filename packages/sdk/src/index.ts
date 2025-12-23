/**
 * @synap/sdk - High-Level SDK for Synap
 * 
 * Event-sourced personal data platform SDK with type-safe APIs.
 * 
 * @example
 * ```typescript
 * import { SynapSDK } from '@synap/sdk';
 * 
 * const synap = new SynapSDK({
 *   url: 'https://api.synap.app',
 *   apiKey: 'your-api-key'
 * });
 * 
 * // Create entity (event-sourced)
 * const task = await synap.entities.create({
 *   type: 'task',
 *   title: 'Call Marie',
 *   metadata: { dueDate: '2024-12-20', priority: 'high' }
 * });
 * 
 * // Create relationship (event-sourced)
 * await synap.relations.create(taskId, personId, 'assigned_to');
 * 
 * // Query data (direct read)
 * const tasks = await synap.entities.list({ type: 'task' });
 * const history = await synap.events.getHistory(taskId);
 * ```
 */

export { SynapSDK, type SynapSDKConfig } from './client.js';
export { EntitiesAPI } from './resources/entities.js';
export { RelationsAPI } from './resources/relations.js';
export { EventsAPI } from './resources/events.js';

// Re-export types from @synap/types for convenience
export type {
  EntityType,
  EntityMetadata,
  Entity,
  NewEntity,
  UpdateEntity,
} from '@synap/types/entities';

export type {
  Relation,
  RelationType,
} from './types/relations.js';

export type {
  Event,
  EventFilter,
} from './types/events.js';
