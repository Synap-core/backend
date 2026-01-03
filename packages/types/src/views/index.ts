/**
 * View Types
 * 
 * Re-exports view types from database schema (single source of truth).
 * Extended with Table Inversion System configuration types.
 * 
 * @see {@link @synap-core/database/schema}
 */

// Direct re-exports from database
export type { 
  View,
  NewView,
} from '@synap-core/database/schema';

// =============================================================================
// View Type Enum
// =============================================================================

/**
 * View types - categorized by rendering approach
 */
export type ViewType = 
  // Canvas-based (freeform)
  | 'whiteboard'
  // Table-based (Table Inversion System)
  | 'table'
  | 'kanban'
  | 'list'
  | 'grid'
  | 'gallery'
  | 'calendar'
  | 'gantt'
  | 'timeline'
  // Specialized
  | 'mindmap'
  | 'graph';

// =============================================================================
// Table Inversion System Configuration
// =============================================================================

export interface ColumnDefinition {
  id: string;
  name: string;
  type: 'text' | 'number' | 'date' | 'select' | 'multi-select' | 'checkbox' | 'url' | 'email' | 'phone' | 'person' | 'relation' | 'formula' | 'rollup';
  options?: string[];
  relationTableId?: string;
  formula?: string;
  width?: number;
  isHidden?: boolean;
}

export interface FilterRule {
  columnId: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'is_empty' | 'is_not_empty' | 'greater_than' | 'less_than' | 'date_is' | 'date_before' | 'date_after';
  value?: unknown;
}

export interface SortRule {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface TableViewConfig {
  layout: 'table' | 'kanban' | 'list' | 'grid' | 'gallery' | 'calendar' | 'gantt' | 'timeline';
  columns: ColumnDefinition[];
  filters?: FilterRule[];
  sorts?: SortRule[];
  groupByColumnId?: string;
}

// =============================================================================
// API Input Types
// =============================================================================

export interface CreateViewInput {
  workspaceId?: string;
  type: ViewType;
  name: string;
  description?: string;
  initialContent?: unknown;
  tableConfig?: TableViewConfig;
}

export interface UpdateViewInput {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  tableConfig?: Partial<TableViewConfig>;
}
