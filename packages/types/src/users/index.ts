/**
 * User Types
 * 
 * Types for users and user-entity state.
 */

/**
 * User entity state - tracks user interaction with entities
 */
export interface UserEntityState {
  userId: string;
  itemId: string;
  itemType: 'entity' | 'inbox_item';
  
  // Interaction flags
  starred: boolean;
  pinned: boolean;
  
  // Analytics
  lastViewedAt?: Date;
  viewCount: number;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Entity enrichment - AI-generated metadata
 */
export interface EntityEnrichment {
  id: string;
  entityId: string;
  enrichmentType: 'extraction' | 'properties' | 'classification' | 'knowledge';
  
  // AI metadata
  agentId: string;
  confidence: number;
  
  // Enrichment data
  data: unknown; // Type depends on enrichmentType
  
  // Traceability
  sourceEventId: string;
  userId: string;
  
  createdAt: Date;
}

/**
 * Entity relationship - knowledge graph edge
 */
export interface EntityRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: 
    | 'related_to'
    | 'part_of'
    | 'depends_on'
    | 'mentioned_in'
    | 'created_from'
    | 'supersedes'
    | 'similar_to'
    | 'contradicts';
  
  // AI metadata
  agentId: string;
  confidence: number;
  context?: string;
  
  // Traceability
  sourceEventId: string;
  userId: string;
  
  createdAt: Date;
}

/**
 * Reasoning trace - AI decision transparency
 */
export interface ReasoningTrace {
  id: string;
  subjectType: 'entity' | 'message' | 'thread' | 'query' | 'task';
  subjectId: string;
  
  // Source event
  sourceEventId: string;
  agentId: string;
  
  // Reasoning data
  steps: unknown[]; // Array of reasoning steps
  outcome: unknown; // Final decision
  metrics?: unknown; // Performance metrics
  
  userId: string;
  createdAt: Date;
}
