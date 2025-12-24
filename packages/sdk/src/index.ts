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
 *   apiKey: 'your-api-key',
 *   realtime: {
 *     userId: 'user-123',
 *     userName: 'Alice',
 *   },
 * });
 * 
 * // Create entity (event-sourced)
 * const task = await synap.entities.create({
 *   type: 'task',
 *   title: 'Call Marie',
 *   metadata: { dueDate: '2024-12-20', priority: 'high' }
 * });
 * 
 * // Create workspace
 * const workspace = await synap.workspaces.create({ name: 'Team' });
 * 
 * // Create whiteboard
 * const board = await synap.views.create({
 *   type: 'whiteboard',
 *   name: 'Brainstorm',
 *   workspaceId: workspace.id,
 * });
 * 
 * // Real-time collaboration
 * synap.realtime?.connectPresence(board.id);
 * const ydoc = synap.realtime?.connectYjs(board.id);
 * ```
 */

export { SynapSDK, type SynapSDKConfig } from './client.js';
export { EntitiesAPI } from './resources/entities.js';
export { RelationsAPI } from './resources/relations.js';
export { EventsAPI } from './resources/events.js';
export { WorkspacesAPI } from './resources/workspaces.js';
export { ViewsAPI } from './resources/views.js';
export { PreferencesAPI } from './resources/preferences.js';

// Re-export types from @synap-core/types for convenience
export type {
  EntityType,
  EntityMetadata,
  Entity,
  NewEntity,
  UpdateEntity,
} from '@synap-core/types/entities';

export type {
  Workspace,
  WorkspaceMember,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
} from '@synap-core/types/workspaces';

export type {
  View,
  CreateViewInput,
  UpdateViewInput,
} from '@synap-core/types/views';

export type {
  UserPreferences,
  UpdatePreferencesInput,
} from '@synap-core/types/preferences';

export type {
  UserPresence,
  YDoc,
} from '@synap-core/types/realtime';

export type {
  Relation,
  RelationType,
} from './types/relations.js';

export type {
  Event,
  EventFilter,
} from './types/events.js';
