/**
 * View Query Types
 *
 * Single source of truth for all view query and filter types.
 */

// =============================================================================
// Filter and Sort Types
// =============================================================================

/**
 * Filter operator types
 */
export type FilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "in"
  | "not_in"
  | "is_empty"
  | "is_not_empty"
  | "greater_than"
  | "less_than"
  | "greater_than_or_equal"
  | "less_than_or_equal";

/**
 * Filter definition for entity queries
 */
export interface EntityFilter {
  field: string;
  operator: FilterOperator;
  value?: unknown;
}

/**
 * Sort rule for entity queries
 */
export interface SortRule {
  field: string;
  direction: "asc" | "desc";
}

// =============================================================================
// Entity Query
// =============================================================================

/**
 * Query definition for structured views
 * Defines which entities to show and how to filter them
 */
export interface EntityQuery {
  /** Entity types to include */
  entityTypes?: string[];

  /** Specific entity IDs (for fixed sets) */
  entityIds?: string[];

  /** Filter conditions */
  filters?: EntityFilter[];

  /** Sort rules (multiple sorts supported) */
  sorts?: SortRule[];

  /** Full-text search query */
  search?: string;

  /** Maximum number of entities to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Group by field (for kanban, timeline) */
  groupBy?: string;
}
