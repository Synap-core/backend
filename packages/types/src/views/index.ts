/**
 * View Types
 * 
 * Re-exports view types from database schema (single source of truth).
 * 
 * @see {@link file:///.../packages/database/src/schema/views.ts}
 */

// Direct re-exports from database
export type { 
  View,
  NewView,
} from '@synap/database/schema';

// Derived types
import type { View } from '@synap/database/schema';

export type ViewType = View['type'];

// Input types for API operations
export interface CreateViewInput {
  workspaceId?: string;
  type: ViewType;
  name: string;
  description?: string;
  initialContent?: unknown;
}

export interface UpdateViewInput {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SaveViewInput {
  viewId: string;
  content: unknown;
  saveType?: 'auto' | 'manual' | 'publish';
}
