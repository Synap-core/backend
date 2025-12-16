/**
 * Database Schema - Export all tables
 */

export * from './events.js';
export * from './entities.js';
export * from './entity-vectors.js';
export * from './documents.js';
export * from './relations.js';
export * from './task_details.js';
export * from './tags.js';
export * from './entity_tags.js';
export * from './conversation-messages.js';
export * from './knowledge-facts.js';
export * from './ai-suggestions.js';
export * from './api-keys.js';
export * from './webhook_subscriptions.js';

// New schemas for chat system
export * from './chat-threads.js';
export * from './agents.js';
export * from './projects.js';

// AI Enrichment schemas (event-based)
export * from './enrichments.js';

// Life Feed schemas
export * from './inbox-items.js';
export * from './user-entity-state.js';

// Intelligence Service Registry
export * from './intelligence-services.js';
