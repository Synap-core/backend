/**
 * @synap/types - Shared Domain Types
 * 
 * Core type definitions for the Synap ecosystem.
 * Used by frontend, backend, and Intelligence Hub.
 */

// Entity types
export * from './entities/index.js';

// Document types
export * from './documents/index.js';

// User and context types
export * from './users/index.js';

// Inbox types
export * from './inbox/index.js';

// Template types
export * from './templates/types.js';
export * from './templates/schemas.js';

// Default Templates
export { notionLikeTemplate } from './templates/notion-like.template.js';
export { classicNoteTemplate } from './templates/classic-note.template.js';
export { wikiReferenceTemplate } from './templates/wiki-reference.template.js';

// Workspaces
export * from './workspaces/index.js';

// Views
export * from './views/index.js';

// Relations
export * from './relations/index.js';

// Preferences
export * from './preferences/index.js';

// Realtime types (for WebSocket/collaboration)
export * from './realtime/index.js';
