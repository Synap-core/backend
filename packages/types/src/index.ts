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

// Error types (browser-compatible)
export * from './errors/index.js';

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

// Hub Protocol (Intelligence Service contract)
export * from './hub-protocol/index.js';

// Approvals
export * from './approvals/index.js';

// Chat domain types
export * from './chat/index.js';

// Universal Proposals
export * from './proposals/index.js';
