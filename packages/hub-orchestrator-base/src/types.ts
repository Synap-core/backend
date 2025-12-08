/**
 * Hub Orchestrator Types
 * 
 * Type definitions for the Hub Orchestrator pattern
 */

import type { HubInsight } from '@synap/hub-protocol';

/**
 * Expertise Request
 * 
 * Request from Data Pod to Hub for processing
 */
export interface ExpertiseRequest {
  /** Request ID (UUID) */
  requestId: string;
  
  /** User ID */
  userId: string;
  
  /** Data Pod URL */
  dataPodUrl: string;
  
  /** User query or request */
  query: string;
  
  /** Optional: Specific agent ID to use */
  agentId?: string;
  
  /** Optional: Additional context */
  context?: Record<string, unknown>;
}

/**
 * Expertise Response
 * 
 * Response from Hub to Data Pod with insight or error
 */
export interface ExpertiseResponse {
  /** Request ID */
  requestId: string;
  
  /** Status */
  status: 'completed' | 'failed';
  
  /** Insight submitted (if successful) */
  insight?: HubInsight;
  
  /** Error message (if failed) */
  error?: string;
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

