/**
 * View Filter Compiler Service
 *
 * Compiles view filters to optimized SQL queries.
 * Uses entity_property_index when available, falls back to JSONB queries.
 */

import { sql, eq, and, SQL } from "drizzle-orm";
import { entities, entityPropertyIndex } from "../schema/index.js";
import { ProfileResolutionService } from "./profile-resolution-service.js";
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
  private profileResolution: ProfileResolutionService;

  constructor(db: PostgresJsDatabase<typeof import("../schema/index.js")>) {
    this.profileResolution = new ProfileResolutionService(db);
  }

  /**
   * Compile a single filter condition
   * Returns optimized SQL using index if available, otherwise JSONB query
   */
  async compileFilter(
    filter: EntityFilter,
    profileId?: string
  ): Promise<CompiledFilter | null> {
    const { field, operator, value } = filter;

    // Check if this is a property field (starts with "properties." or "metadata.")
    const isPropertyField =
      field.startsWith("properties.") || field.startsWith("metadata.");

    if (!isPropertyField) {
      // Standard entity column - use direct column access
      return this.compileStandardFieldFilter(filter);
    }

    // Extract property key
    const propertyKey = field.split(".")[1];
    if (!propertyKey) {
      return null;
    }

    // Try to use index if property is indexed
    if (profileId) {
      const indexedFilter = await this.compileIndexedPropertyFilter(
        propertyKey,
        operator,
        value,
        profileId
      );
      if (indexedFilter) {
        return indexedFilter;
      }
    }

    // Fallback to JSONB query
    return this.compileJSONBPropertyFilter(propertyKey, operator, value);
  }

  /**
   * Compile multiple filters into a single SQL condition
   */
  async compileFilters(
    filters: EntityFilter[],
    profileId?: string
  ): Promise<SQL | null> {
    if (filters.length === 0) {
      return null;
    }

    const compiledFilters: SQL[] = [];

    for (const filter of filters) {
      const compiled = await this.compileFilter(filter, profileId);
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
   * Compile filter for indexed property (uses entity_property_index)
   */
  private async compileIndexedPropertyFilter(
    propertyKey: string,
    operator: string,
    value: unknown,
    profileId: string
  ): Promise<CompiledFilter | null> {
    // Get effective properties to find property definition
    const effectiveProperties =
      await this.profileResolution.getEffectiveProperties(profileId);
    const propertyDef = effectiveProperties.find((p) => p.slug === propertyKey);

    if (!propertyDef) {
      return null; // Property not in profile, fallback to JSONB
    }

    // Check if property is indexed (for now, we assume hot properties are indexed)
    // TODO: Add "indexed" flag to profile_properties table
    const hotProperties = [
      "title",
      "status",
      "priority",
      "dueDate",
      "startTime",
      "endTime",
      "assignee",
    ];

    if (!hotProperties.includes(propertyKey)) {
      return null; // Not indexed, fallback to JSONB
    }

    // Build SQL using entity_property_index
    // Join with entity_property_index to filter by indexed value
    const valueType = propertyDef.valueType;

    switch (operator) {
      case "equals":
        return this.buildIndexedEqualsFilter(propertyDef.id, value, valueType);
      case "not_equals":
        return this.buildIndexedNotEqualsFilter(
          propertyDef.id,
          value,
          valueType
        );
      case "in":
        if (Array.isArray(value)) {
          return this.buildIndexedInFilter(propertyDef.id, value, valueType);
        }
        return null;
      case "greater_than":
      case "greater_than_or_equal":
      case "less_than":
      case "less_than_or_equal":
        return this.buildIndexedRangeFilter(
          propertyDef.id,
          operator,
          value,
          valueType
        );
      default:
        return null; // Fallback to JSONB for unsupported operators
    }
  }

  /**
   * Build indexed equals filter
   */
  private buildIndexedEqualsFilter(
    propertyDefId: string,
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
            AND ${entityPropertyIndex.propertyDefId} = ${propertyDefId}
            AND ${valueColumn} = ${value}
        )
      `,
      usesIndex: true,
    };
  }

  /**
   * Build indexed not equals filter
   */
  private buildIndexedNotEqualsFilter(
    propertyDefId: string,
    value: unknown,
    valueType: string
  ): CompiledFilter {
    // Similar to equals but with NOT
    const equalsFilter = this.buildIndexedEqualsFilter(
      propertyDefId,
      value,
      valueType
    );
    return {
      sql: sql`NOT ${equalsFilter.sql}`,
      usesIndex: true,
    };
  }

  /**
   * Build indexed IN filter
   */
  private buildIndexedInFilter(
    propertyDefId: string,
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
            AND ${entityPropertyIndex.propertyDefId} = ${propertyDefId}
            AND ${valueColumn} = ANY(${values})
        )
      `,
      usesIndex: true,
    };
  }

  /**
   * Build indexed range filter (gt, gte, lt, lte)
   */
  private buildIndexedRangeFilter(
    propertyDefId: string,
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
            AND ${entityPropertyIndex.propertyDefId} = ${propertyDefId}
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
