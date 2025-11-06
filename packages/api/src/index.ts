/**
 * API Package - Main Export
 */

export * from './trpc.js';
export * from './context.js';
export { eventsRouter } from './routers/events.js';
export { captureRouter } from './routers/capture.js';
export { requireUserId, userScope, userScopeAnd, type EventDataWithUser } from './utils/user-scoped.js';

import { router } from './trpc.js';
import { eventsRouter } from './routers/events.js';
import { captureRouter } from './routers/capture.js';
import { notesRouter } from './routers/notes.js';
import { createContext } from './context.js';

// Main app router
export const appRouter = router({
  events: eventsRouter,
  capture: captureRouter,
  notes: notesRouter,
  // Future routers:
  // entities: entitiesRouter,
  // search: searchRouter,
});

export type AppRouter = typeof appRouter;

// Explicit re-export for server
export { createContext };

