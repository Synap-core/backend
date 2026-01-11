/**
 * Approval Types
 * 
 * Types for AI proposal approval workflow.
 * Used across backend and frontend for approval requests.
 */

import type { AgentTypeString } from '../hub-protocol/index.js';

// =============================================================================
// Approval Status & Type
// =============================================================================

/**
 * Approval request status
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/**
 * Approval request type
 */
export type ApprovalType = 'entity' | 'document' | 'action' | 'branch';

// =============================================================================
// Base Approval Request
// =============================================================================

/**
 * Base approval request interface
 */
export interface BaseApprovalRequest {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requestedBy: string;
  requestedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reason?: string;
  confidence?: number;
}

// =============================================================================
// Specific Approval Request Types
// =============================================================================

/**
 * Entity approval request
 */
export interface EntityApprovalRequest extends BaseApprovalRequest {
  type: 'entity';
  entityType: string;
  title: string;
  description?: string;
  data: Record<string, unknown>;
}

/**
 * Document approval request
 */
export interface DocumentApprovalRequest extends BaseApprovalRequest {
  type: 'document';
  operation: 'create' | 'update' | 'delete';
  documentId?: string;
  title?: string;
  content?: string;
  changes?: Record<string, unknown>;
}

/**
 * Action approval request
 */
export interface ActionApprovalRequest extends BaseApprovalRequest {
  type: 'action';
  action: string;
  description: string;
  args: Record<string, unknown>;
}

/**
 * Branch approval request
 */
export interface BranchApprovalRequest extends BaseApprovalRequest {
  type: 'branch';
  agentType: AgentTypeString;
  title: string;
  purpose: string;
}

// =============================================================================
// Union Types
// =============================================================================

/**
 * Union type for all approval requests
 */
export type ApprovalRequest = 
  | EntityApprovalRequest
  | DocumentApprovalRequest
  | ActionApprovalRequest
  | BranchApprovalRequest;

// =============================================================================
// Approval Actions
// =============================================================================

/**
 * Approve request input
 */
export interface ApproveRequestInput {
  requestId: string;
  reason?: string;
}

/**
 * Reject request input
 */
export interface RejectRequestInput {
  requestId: string;
  reason: string;
}

// =============================================================================
// Approval Lists & Filters
// =============================================================================

/**
 * Approval filter parameters
 */
export interface ApprovalFilter {
  type?: ApprovalType | ApprovalType[];
  status?: ApprovalStatus | ApprovalStatus[];
  requestedBy?: string;
  createdAfter?: string;
  createdBefore?: string;
}

/**
 * Approval query parameters
 */
export interface ApprovalQuery {
  filter?: ApprovalFilter;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'status' | 'type';
  sortOrder?: 'asc' | 'desc';
}
