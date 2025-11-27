/**
 * API Package - Main Export
 */

import './event-publisher.js';
import { initializePlugins } from './plugins/init.js';

// Initialize plugins at module load
// This ensures plugins are registered before the app router is built
initializePlugins().catch((error) => {
  console.error('Failed to initialize plugins:', error);
});
export * from './trpc.js';
export * from './context.js';
export { eventsRouter } from './routers/events.js';
export { captureRouter } from './routers/capture.js';
export { chatRouter } from './routers/chat.js';
export { suggestionsRouter } from './routers/suggestions.js';
export { systemRouter } from './routers/system.js';
export { hubRouter } from './routers/hub.js';
export { apiKeysRouter } from './routers/api-keys.js';
export { requireUserId, userScope, userScopeAnd, type EventDataWithUser } from './utils/user-scoped.js';
export { eventStreamManager } from './event-stream-manager.js';
export { setupEventBroadcasting } from './setup-event-broadcasting.js';

import { eventsRouter } from './routers/events.js';
import { captureRouter } from './routers/capture.js';
import { notesRouter } from './routers/notes.js';
import { chatRouter } from './routers/chat.js';
import { suggestionsRouter } from './routers/suggestions.js';
import { systemRouter } from './routers/system.js';
import { hubRouter } from './routers/hub.js';
import { apiKeysRouter } from './routers/api-keys.js';
import { createContext } from './context.js';
import { registerRouter, buildAppRouter } from './router-registry.js';

// V1.0: Register core routers dynamically
// These are the built-in routers that come with the kernel
registerRouter('events', eventsRouter, { version: '1.0.0', source: 'core', description: 'Event logging API' });
registerRouter('capture', captureRouter, { version: '1.0.0', source: 'core', description: 'Thought capture API' });
registerRouter('notes', notesRouter, { version: '1.0.0', source: 'core', description: 'Notes management API' });
registerRouter('chat', chatRouter, { version: '1.0.0', source: 'core', description: 'Conversational interface API' });
registerRouter('suggestions', suggestionsRouter, { version: '1.0.0', source: 'core', description: 'AI suggestions API' });
registerRouter('system', systemRouter, { version: '1.0.0', source: 'core', description: 'System meta-information and control' });
registerRouter('hub', hubRouter, { version: '1.0.0', source: 'core', description: 'Hub Protocol V1.0 - Intelligence Hub communication' });
registerRouter('apiKeys', apiKeysRouter, { version: '1.0.0', source: 'core', description: 'API key management for Hub authentication' });

// Build the main app router from all registered routers
// This enables plugins to add routers without modifying core code
export const appRouter = buildAppRouter();

export type AppRouter = typeof appRouter;

// Re-export router registry functions for plugin developers
export {
  registerRouter,
  unregisterRouter,
  dynamicRouterRegistry,
  getRouter,
  buildAppRouter,
} from './router-registry.js';

// Re-export plugin system
export {
  pluginManager,
  intelligenceHubPlugin,
  type DataPodPlugin,
  type ThoughtInput,
  type ThoughtResponse,
} from './plugins/index.js';

// Explicit re-export for server
export { createContext };

