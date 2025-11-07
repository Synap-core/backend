/**
 * API Package - Main Export
 */

import './event-publisher.js';
export * from './trpc.js';
export * from './context.js';
export { eventsRouter } from './routers/events.js';
export { captureRouter } from './routers/capture.js';
export { chatRouter } from './routers/chat.js';
export { suggestionsRouter } from './routers/suggestions.js';
export { requireUserId, userScope, userScopeAnd, type EventDataWithUser } from './utils/user-scoped.js';

import { router } from './trpc.js';
import { eventsRouter } from './routers/events.js';
import { captureRouter } from './routers/capture.js';
import { notesRouter } from './routers/notes.js';
import { chatRouter } from './routers/chat.js';
import { suggestionsRouter } from './routers/suggestions.js';
import { createContext } from './context.js';

// Main app router
export const appRouter = router({
  events: eventsRouter,
  capture: captureRouter,
  notes: notesRouter,
  chat: chatRouter,  // V0.4: Conversational interface
  suggestions: suggestionsRouter,
  // Future routers:
  // entities: entitiesRouter,
  // search: searchRouter,
});

export type AppRouter = typeof appRouter;

// Explicit re-export for server
export { createContext };

