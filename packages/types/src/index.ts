/**
 * @synap/types - Shared Domain Types
 * 
 * Core type definitions for the Synap ecosystem.
 * Used by frontend, backend, and Intelligence Hub.
 * 
 * All types re-export from database schemas to maintain single source of truth.
 */

// Entity types
export * from './entities/index.js';

// Document types
export * from './documents/index.js';

// User and context types
export * from './users/index.js';

// Inbox types  
export * from './inbox/index.js';

// Workspace types (V3.0)
export * from './workspaces/index.js';

// View types (V3.0)
export * from './views/index.js';

// Preferences types (V3.0)
export * from './preferences/index.js';

// Real-time types (V3.0)
export * from './realtime/index.js';
