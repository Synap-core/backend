/**
 * View Query Types
 *
 * Single source of truth for all view query and filter types.
 */
/**
 * Filter operator types
 */
export type FilterOperator = "equals" | "not_equals" | "contains" | "not_contains" | "in" | "not_in" | "is_empty" | "is_not_empty" | "greater_than" | "less_than" | "greater_than_or_equal" | "less_than_or_equal";
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
/**
 * Query definition for structured views
 * Defines which entities to show and how to filter them
 *
 * NOTE: profileIds/profileSlugs are now stored in views.scopeProfileIds
 * This query structure only contains filters, sorts, search, pagination, and groupBy
 */
export interface EntityQuery {
    /** @deprecated - Profile IDs now stored in views.scopeProfileIds */
    profileIds?: string[];
    /** @deprecated - Profile slugs now stored in views.scopeProfileIds (resolved to IDs) */
    profileSlugs?: string[];
    /** @deprecated - Use profileSlugs instead, which is also deprecated */
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
//# sourceMappingURL=query.d.ts.map