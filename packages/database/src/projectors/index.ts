/**
 * Projectors - Event to Projection Handlers
 * 
 * Projectors process events and update materialized views/tables.
 * These are the building blocks of event sourcing.
 * 
 * Key Pattern:
 * - Events are the source of truth (with optional metadata)
 * - Projectors extract relevant data into optimized tables
 * - Projections can be rebuilt from events anytime
 * 
 * @module @synap/database/projectors
 */

// Metadata Projector - extracts AI metadata from event.metadata
export {
  projectEventMetadata,
  rebuildMetadataProjections,
} from './metadata-projector.js';

// Legacy Enrichment Projector - for backward compatibility with enrichment.* events
export {
  projectEnrichmentEvent,
  rebuildEnrichmentProjections,
} from './enrichment-projector.js';
