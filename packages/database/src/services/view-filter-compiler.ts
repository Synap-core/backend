/**
 * View Filter Compiler Service
 *
 * Compiles view filters to optimized SQL queries.
 * Uses entity_property_index when available, falls back to JSONB queries.
 */

import { sql, eq, and, type SQL } from "drizzle-orm";
import { entities, entityPropertyIndex } from "../schema/index.js";
import { PropertyMergingService } from "./property-merging-service.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// EntityFilter type definition (from @synap-core/types)
export interface EntityFilter {
  field: string;
  operator:
    | "equals"
    | "not_equals"
    | "contains"
    | "not_contains"
    | "is_empty"
    | "is_not_empty"
    | "in"
    | "not_in"
    | "greater_than"
    | "less_than"
    | "greater_than_or_equal"
    | "less_than_or_equal";
  value?: unknown;
}

export interface CompiledFilter {
  sql: SQL;
  usesIndex: boolean;
}

export class ViewFilterCompiler {
  private propertyMerging: PropertyMergingService;
  private db: PostgresJsDatabase<typeof import("../schema/index.js")>;

  constructor(db: PostgresJsDatabase<typeof import("../schema/index.js")>) {
    this.db = db;
    this.propertyMerging = new PropertyMergingService(db);
  }

  /**
   * Compile a single filter condition
   * Returns optimized SQL using index if available, otherwise JSONB query
   *
   * @param filter - Filter to compile
   * @param scopeProfileIds - Array of profile IDs (multi-profile support)
   * @param propertyDefMap - Pre-resolved map of property slug -> propertyDefIds (optional, to avoid N+1)
   */
  async compileFilter(
    filter: EntityFilter,
    scopeProfileIds?: string[],
    propertyDefMap?: Map<string, string[]>
  ): Promise<CompiledFilter | null> {
    const { field, operator, value } = filter;

    // Check if this is a property field (starts with "properties.")
    const isPropertyField = field.startsWith("properties.");

    if (!isPropertyField) {
      // Standard entity column - use direct column access
      return this.compileStandardFieldFilter(filter);
    }

    // Extract property slug
    const propertySlug = field.split(".")[1];
    if (!propertySlug) {
      return null;
    }

    // Resolve propertyDefIds (pre-resolved if provided, otherwise resolve now)
    let propertyDefIds: string[] = [];
    if (propertyDefMap) {
      propertyDefIds = propertyDefMap.get(propertySlug) || [];
    } else if (scopeProfileIds && scopeProfileIds.length > 0) {
      propertyDefIds = await this.propertyMerging.resolvePropertyDefIds(
        propertySlug,
        scopeProfileIds,
        this.db
      );
    }

    // ✅ FIX: Error on unknown property (don't silently skip)
    if (
      propertyDefIds.length === 0 &&
      scopeProfileIds &&
      scopeProfileIds.length > 0
    ) {
      throw new Error(
        `Property "${propertySlug}" not found in scope profiles. Available properties: ${scopeProfileIds ? "check scopeProfileIds" : "none"}`
      );
    }

    // If no scopeProfileIds, fallback to JSONB (legacy support)
    if (propertyDefIds.length === 0) {
      return this.compileJSONBPropertyFilter(propertySlug, operator, value);
    }

    // Try to use index if property is indexed
    if (scopeProfileIds && scopeProfileIds.length > 0) {
      const isIndexed = await this.propertyMerging.isPropertyIndexed(
        propertySlug,
        scopeProfileIds,
        this.db
      );

      if (isIndexed) {
        const indexedFilter =
          await this.compileIndexedPropertyFilterMultiProfile(
            propertyDefIds,
            operator,
            value,
            propertySlug,
            scopeProfileIds
          );
        if (indexedFilter) {
          return indexedFilter;
        }
      }
    }

    // Fallback to JSONB query
    return this.compileJSONBPropertyFilter(propertySlug, operator, value);
  }

  /**
   * Compile multiple filters into a single SQL condition
   *
   * @param filters - Filters to compile
   * @param scopeProfileIds - Array of profile IDs (multi-profile support)
   * @param propertyDefMap - Pre-resolved map (optional, to avoid N+1)
   */
  async compileFilters(
    filters: EntityFilter[],
    scopeProfileIds?: string[],
    propertyDefMap?: Map<string, string[]>
  ): Promise<SQL | null> {
    if (filters.length === 0) {
      return null;
    }

    // Pre-resolve property definitions if not provided (avoid N+1)
    let resolvedPropertyDefMap = propertyDefMap;
    if (
      !resolvedPropertyDefMap &&
      scopeProfileIds &&
      scopeProfileIds.length > 0
    ) {
      resolvedPropertyDefMap = await this.buildPropertyDefMap(scopeProfileIds);
    }

    const compiledFilters: SQL[] = [];

    for (const filter of filters) {
      const compiled = await this.compileFilter(
        filter,
        scopeProfileIds,
        resolvedPropertyDefMap
      );
      if (compiled !== null) {
        compiledFilters.push(compiled.sql);
      }
    }

    if (compiledFilters.length === 0) {
      return null;
    }

    if (compiledFilters.length === 1) {
      const first = compiledFilters[0];
      if (!first) return null;
      return first;
    }

    const combined = and(...compiledFilters);
    return combined ?? null;
  }

  /**
   * Build property definition map (pre-resolve to avoid N+1)
   * Returns map of property slug -> propertyDefIds[]
   */
  private async buildPropertyDefMap(
    scopeProfileIds: string[]
  ): Promise<Map<string, string[]>> {
    const merged = await this.propertyMerging.mergePropertiesFromProfiles(
      scopeProfileIds,
      this.db
    );

    const map = new Map<string, string[]>();
    for (const [slug, prop] of merged) {
      map.set(slug, prop.propertyDefIds);
    }

    return map;
  }

  /**
   * Compile filter for standard entity columns (title, preview, etc.)
   */
  private compileStandardFieldFilter(
    filter: EntityFilter
  ): CompiledFilter | null {
    const { field, operator, value } = filter;
    const entityColumns = entities;

    // Map field names to columns
    let column: any;
    switch (field) {
      case "title":
        column = entityColumns.title;
        break;
      case "preview":
        column = entityColumns.preview;
        break;
      case "type":
        column = entityColumns.type;
        break;
      case "createdAt":
        column = entityColumns.createdAt;
        break;
      case "updatedAt":
        column = entityColumns.updatedAt;
        break;
      default:
        return null;
    }

    switch (operator) {
      case "equals":
        return { sql: eq(column, value as string), usesIndex: false };
      case "not_equals":
        return { sql: sql`${column} != ${value}`, usesIndex: false };
      case "contains":
        return {
          sql: sql`${column} ILIKE ${`%${value}%`}`,
          usesIndex: false,
        };
      case "is_empty":
        return { sql: sql`${column} IS NULL`, usesIndex: false };
      case "is_not_empty":
        return { sql: sql`${column} IS NOT NULL`, usesIndex: false };
      case "in":
        if (Array.isArray(value)) {
          return {
            sql: sql`${column} = ANY(${value})`,
            usesIndex: false,
          };
        }
        return null;
      case "greater_than":
        return { sql: sql`${column} > ${value}`, usesIndex: false };
      case "greater_than_or_equal":
        return { sql: sql`${column} >= ${value}`, usesIndex: false };
      case "less_than":
        return { sql: sql`${column} < ${value}`, usesIndex: false };
      case "less_than_or_equal":
        return { sql: sql`${column} <= ${value}`, usesIndex: false };
      case "not_contains":
        return {
          sql: sql`${column} NOT ILIKE ${`%${value}%`}`,
          usesIndex: false,
        };
      case "not_in":
        if (Array.isArray(value)) {
          return {
            sql: sql`${column} != ALL(${value})`,
            usesIndex: false,
          };
        }
        return null;
      default:
        return null;
    }
  }

  /**
   * Compile filter for indexed property (multi-profile support)
   * Uses entity_property_index with propertyDefId IN (...)
   */
  private async compileIndexedPropertyFilterMultiProfile(
    propertyDefIds: string[],
    operator: string,
    value: unknown,
    propertySlug: string,
    scopeProfileIds: string[]
  ): Promise<CompiledFilter | null> {
    if (propertyDefIds.length === 0 || scopeProfileIds.length === 0) {
      return null;
    }

    // Get value type from merged properties
    const merged = await this.propertyMerging.mergePropertiesFromProfiles(
      scopeProfileIds,
      this.db
    );
    const property = merged.get(propertySlug);
    if (!property) {
      return null;
    }

    const valueType = property.valueType;

    switch (operator) {
      case "equals":
        return this.buildIndexedEqualsFilterMultiProfile(
          propertyDefIds,
          value,
          valueType
        );
      case "not_equals":
        return this.buildIndexedNotEqualsFilterMultiProfile(
          propertyDefIds,
          value,
          valueType
        );
      case "in":
        if (Array.isArray(value)) {
          return this.buildIndexedInFilterMultiProfile(
            propertyDefIds,
            value,
            valueType
          );
        }
        return null;
      case "greater_than":
      case "greater_than_or_equal":
      case "less_than":
      case "less_than_or_equal":
        return this.buildIndexedRangeFilterMultiProfile(
          propertyDefIds,
          operator,
          value,
          valueType
        );
      default:
        return null; // Fallback to JSONB for unsupported operators
    }
  }

  /**
   * Build indexed equals filter (multi-profile - uses propertyDefId IN (...))
   */
  private buildIndexedEqualsFilterMultiProfile(
    propertyDefIds: string[],
    value: unknown,
    valueType: string
  ): CompiledFilter {
    let valueColumn: any;
    switch (valueType) {
      case "string":
      case "entity_id":
        valueColumn = entityPropertyIndex.valueText;
        break;
      case "number":
        valueColumn = entityPropertyIndex.valueNum;
        break;
      case "boolean":
        valueColumn = entityPropertyIndex.valueBool;
        break;
      case "date":
        valueColumn = entityPropertyIndex.valueTs;
        break;
      default:
        return this.compileJSONBPropertyFilter("", "equals", value)!;
    }

    return {
      sql: sql`
        EXISTS (
          SELECT 1
          FROM ${entityPropertyIndex}
          WHERE ${entityPropertyIndex.entityId} = ${entities.id}
            AND ${entityPropertyIndex.propertyDefId} = ANY(${propertyDefIds})
            AND ${valueColumn} = ${value}
        )
      `,
      usesIndex: true,
    };
  }

  /**
   * Build indexed not equals filter (multi-profile)
   */
  private buildIndexedNotEqualsFilterMultiProfile(
    propertyDefIds: string[],
    value: unknown,
    valueType: string
  ): CompiledFilter {
    const equalsFilter = this.buildIndexedEqualsFilterMultiProfile(
      propertyDefIds,
      value,
      valueType
    );
    return {
      sql: sql`NOT ${equalsFilter.sql}`,
      usesIndex: true,
    };
  }

  /**
   * Build indexed IN filter (multi-profile)
   */
  private buildIndexedInFilterMultiProfile(
    propertyDefIds: string[],
    values: unknown[],
    valueType: string
  ): CompiledFilter {
    let valueColumn: any;
    switch (valueType) {
      case "string":
      case "entity_id":
        valueColumn = entityPropertyIndex.valueText;
        break;
      case "number":
        valueColumn = entityPropertyIndex.valueNum;
        break;
      case "boolean":
        valueColumn = entityPropertyIndex.valueBool;
        break;
      case "date":
        valueColumn = entityPropertyIndex.valueTs;
        break;
      default:
        return this.compileJSONBPropertyFilter("", "in", values)!;
    }

    return {
      sql: sql`
        EXISTS (
          SELECT 1
          FROM ${entityPropertyIndex}
          WHERE ${entityPropertyIndex.entityId} = ${entities.id}
            AND ${entityPropertyIndex.propertyDefId} = ANY(${propertyDefIds})
            AND ${valueColumn} = ANY(${values})
        )
      `,
      usesIndex: true,
    };
  }

  /**
   * Build indexed range filter (multi-profile)
   */
  private buildIndexedRangeFilterMultiProfile(
    propertyDefIds: string[],
    operator: string,
    value: unknown,
    valueType: string
  ): CompiledFilter | null {
    if (valueType !== "number" && valueType !== "date") {
      return null; // Range only works for numbers and dates
    }

    let valueColumn: any;
    let sqlOperator: string;
    switch (valueType) {
      case "number":
        valueColumn = entityPropertyIndex.valueNum;
        break;
      case "date":
        valueColumn = entityPropertyIndex.valueTs;
        break;
      default:
        return null;
    }

    switch (operator) {
      case "greater_than":
        sqlOperator = ">";
        break;
      case "greater_than_or_equal":
        sqlOperator = ">=";
        break;
      case "less_than":
        sqlOperator = "<";
        break;
      case "less_than_or_equal":
        sqlOperator = "<=";
        break;
      default:
        return null;
    }

    return {
      sql: sql`
        EXISTS (
          SELECT 1
          FROM ${entityPropertyIndex}
          WHERE ${entityPropertyIndex.entityId} = ${entities.id}
            AND ${entityPropertyIndex.propertyDefId} = ANY(${propertyDefIds})
            AND ${valueColumn} ${sql.raw(sqlOperator)} ${value}
        )
      `,
      usesIndex: true,
    };
  }

  /**
   * Compile filter for JSONB property (fallback when not indexed)
   */
  private compileJSONBPropertyFilter(
    propertyKey: string,
    operator: string,
    value: unknown
  ): CompiledFilter {
    const propertiesCol = entities.properties;

    switch (operator) {
      case "equals":
        return {
          sql: sql`(${propertiesCol}->>${propertyKey} = ${value})`,
          usesIndex: false,
        };
      case "not_equals":
        return {
          sql: sql`(${propertiesCol}->>${propertyKey} != ${value})`,
          usesIndex: false,
        };
      case "contains":
        return {
          sql: sql`(${propertiesCol}->>${propertyKey} ILIKE ${`%${value}%`})`,
          usesIndex: false,
        };
      case "is_empty":
        return {
          sql: sql`(${propertiesCol}->>${propertyKey} IS NULL)`,
          usesIndex: false,
        };
      case "is_not_empty":
        return {
          sql: sql`(${propertiesCol}->>${propertyKey} IS NOT NULL)`,
          usesIndex: false,
        };
      case "in":
        if (Array.isArray(value)) {
          return {
            sql: sql`(${propertiesCol}->>${propertyKey} = ANY(${value})`,
            usesIndex: false,
          };
        }
        return {
          sql: sql`FALSE`,
          usesIndex: false,
        };
      default:
        return {
          sql: sql`FALSE`,
          usesIndex: false,
        };
    }
  }
}
