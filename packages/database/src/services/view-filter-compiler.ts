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
import type * as schema from "../schema/index.js";

/**
 * The view filter operators this compiler evaluates — a RUNTIME MIRROR of
 * `VIEW_FILTER_OPERATORS` in `@synap-core/types/views` (`views/filters.ts`),
 * the ONE grammar the UI and the views tRPC doors use.
 *
 * Mirrored, not imported: `@synap-core/types` depends on `@synap/database`, so
 * importing it here is a build cycle (same precedent as
 * `GUIDELINE_SCOPE_ORDER`). `view-filter-operators-parity.test.ts` fails if
 * the two sets differ, AND compiles every operator in the authored set through
 * this class, so an operator added to the grammar cannot reach a view without
 * a compile path.
 */
export const VIEW_FILTER_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "is_empty",
  "is_not_empty",
] as const;

export type ViewFilterOperator = (typeof VIEW_FILTER_OPERATORS)[number];

/**
 * The entity columns a filter may name directly — a RUNTIME MIRROR of
 * `VIEW_FILTER_CORE_FIELDS` in `@synap-core/types/views` (same build-cycle
 * reason as {@link VIEW_FILTER_OPERATORS}; same parity tripwire). Anything
 * else must be `properties.<slug>`; an unknown field THROWS — it never
 * compiles to "no condition", which would return every row as if filtered.
 */
export const VIEW_FILTER_CORE_FIELDS = [
  "title",
  "preview",
  "type",
  "createdAt",
  "updatedAt",
] as const;

// EntityFilter — structurally identical to `@synap-core/types` `EntityFilter`.
export interface EntityFilter {
  field: string;
  operator: ViewFilterOperator;
  value?: unknown;
}

export interface CompiledFilter {
  sql: SQL;
  usesIndex: boolean;
}

/**
 * Per-slug resolved property metadata used during filter compilation.
 * Carries both the resolved property_def IDs (for the indexed-path query)
 * AND whether any of those defs is indexed — so we don't have to re-merge
 * properties inside `compileFilter` just to answer "is it indexed?".
 */
export interface PropertyFilterMeta {
  propertyDefIds: string[];
  indexed: boolean;
}

export class ViewFilterCompiler {
  private propertyMerging: PropertyMergingService;
  private db: PostgresJsDatabase<typeof schema>;
  constructor(db: PostgresJsDatabase<typeof schema>) {
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
    propertyMetaMap?: Map<string, PropertyFilterMeta>,
    workspaceId?: string | null
  ): Promise<CompiledFilter | null> {
    // When `propertyMetaMap` is provided (the normal path from
    // compileFilters → buildPropertyMetaMap), it carries both the resolved
    // def IDs AND the indexed flag — we read both from the same pre-merged
    // map instead of running a second merge per property filter. The
    // `workspaceId` is only used on the degenerate fallback path where a
    // caller invokes compileFilter directly without a pre-built map.
    const { field, operator, value } = filter;

    // Check if this is a property field (starts with "properties.")
    const isPropertyField = field.startsWith("properties.");

    if (!isPropertyField) {
      // Standard entity column - use direct column access
      return this.compileStandardFieldFilter(filter);
    }

    // Extract property slug — exactly `properties.<slug>`.
    const propertySlug = field.slice("properties.".length);
    if (!propertySlug || propertySlug.includes(".")) {
      throw new Error(
        `Filter field "${field}" is not a property field (expected "properties.<slug>")`
      );
    }

    // Resolve propertyDefIds + indexed flag (pre-resolved if provided,
    // otherwise run the merge inline — rare, typically only for direct
    // compileFilter callers outside of view-query flows)
    let propertyDefIds: string[] = [];
    let isIndexed = false;
    if (propertyMetaMap) {
      const meta = propertyMetaMap.get(propertySlug);
      if (meta) {
        propertyDefIds = meta.propertyDefIds;
        isIndexed = meta.indexed;
      }
    } else if (scopeProfileIds && scopeProfileIds.length > 0) {
      // Single merge per inline call — resolves IDs + indexed in one pass.
      const merged = await this.propertyMerging.mergePropertiesFromProfiles(
        scopeProfileIds,
        this.db,
        workspaceId
      );
      const mergedProp = merged.get(propertySlug);
      if (mergedProp) {
        propertyDefIds = mergedProp.propertyDefIds;
        isIndexed = mergedProp.indexed;
      }
    }

    // ✅ Error on unknown property (don't silently skip)
    if (
      propertyDefIds.length === 0 &&
      scopeProfileIds &&
      scopeProfileIds.length > 0
    ) {
      throw new Error(
        `Property "${propertySlug}" not found in scope profiles. Available properties: ${scopeProfileIds ? "check scopeProfileIds" : "none"}`
      );
    }

    // No scopeProfileIds ⇒ there is no schema to check the slug against, so
    // an absent property is not an error, it is "no entity has it": compile
    // against the JSONB bag. DELIBERATE and narrow — `views.execute` always
    // passes scope profiles (an unscoped structured view is refused there),
    // so a view's unknown property always takes the throw above.
    if (propertyDefIds.length === 0) {
      return this.compileJSONBPropertyFilter(propertySlug, operator, value);
    }

    // Try to use index if property is indexed
    if (isIndexed && scopeProfileIds && scopeProfileIds.length > 0) {
      const indexedFilter = await this.compileIndexedPropertyFilterMultiProfile(
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
    propertyMetaMap?: Map<string, PropertyFilterMeta>,
    workspaceId?: string | null
  ): Promise<SQL | null> {
    if (filters.length === 0) {
      return null;
    }

    // Pre-resolve property metadata if not provided (avoid N+1) — scoped to
    // the calling workspace's lens so overlay props from other workspaces
    // don't leak into filter compilation. The meta map carries both def IDs
    // and the indexed flag, so compileFilter never re-merges.
    let resolvedMetaMap = propertyMetaMap;
    if (!resolvedMetaMap && scopeProfileIds && scopeProfileIds.length > 0) {
      resolvedMetaMap = await this.buildPropertyMetaMap(
        scopeProfileIds,
        workspaceId
      );
    }

    const compiledFilters: SQL[] = [];

    for (const filter of filters) {
      const compiled = await this.compileFilter(
        filter,
        scopeProfileIds,
        resolvedMetaMap,
        workspaceId
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
  /**
   * Build the per-slug property metadata map used by `compileFilter`.
   * Returns both the resolved def IDs and the indexed flag so filter
   * compilation never needs to touch the merging service a second time.
   */
  private async buildPropertyMetaMap(
    scopeProfileIds: string[],
    workspaceId?: string | null
  ): Promise<Map<string, PropertyFilterMeta>> {
    const merged = await this.propertyMerging.mergePropertiesFromProfiles(
      scopeProfileIds,
      this.db,
      workspaceId
    );

    const map = new Map<string, PropertyFilterMeta>();
    for (const [slug, prop] of merged) {
      map.set(slug, {
        propertyDefIds: prop.propertyDefIds,
        indexed: prop.indexed,
      });
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
        throw new Error(
          `Unknown filter field "${field}" (expected one of ${VIEW_FILTER_CORE_FIELDS.join(", ")} or "properties.<slug>")`
        );
    }

    // A date-only value on a timestamp column compares by DAY.
    if (
      (field === "createdAt" || field === "updatedAt") &&
      isDateOnlyValue(value)
    ) {
      const day = compileDayCondition(column, operator, value);
      if (day) return { sql: day, usesIndex: false };
    }

    switch (operator) {
      case "equals":
        return { sql: eq(column, value as string), usesIndex: false };
      case "not_equals":
        return {
          sql: sql`(${column} IS DISTINCT FROM ${value})`,
          usesIndex: false,
        };
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
          // Drizzle expands a JS array into `($1, $2)`: valid for IN, not ANY().
          return {
            sql: value.length === 0 ? sql`FALSE` : sql`${column} IN ${value}`,
            usesIndex: false,
          };
        }
        throw requiresArray(operator, field);
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
          sql: negateIncludingMissing(sql`${column} ILIKE ${`%${value}%`}`),
          usesIndex: false,
        };
      case "not_in":
        if (Array.isArray(value)) {
          return {
            sql:
              value.length === 0
                ? sql`TRUE`
                : negateIncludingMissing(sql`${column} IN ${value}`),
            usesIndex: false,
          };
        }
        throw requiresArray(operator, field);
      default:
        throw new Error(
          `Unsupported filter operator "${operator}" on field "${field}"`
        );
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
          valueType,
          propertySlug
        );
      case "not_equals":
        return this.buildIndexedNotEqualsFilterMultiProfile(
          propertyDefIds,
          value,
          valueType,
          propertySlug
        );
      case "in":
        if (Array.isArray(value)) {
          return this.buildIndexedInFilterMultiProfile(
            propertyDefIds,
            value,
            valueType,
            propertySlug
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
    valueType: string,
    propertySlug: string
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
        return this.compileJSONBPropertyFilter(propertySlug, "equals", value);
    }

    // A date-only value means the whole day, not its midnight instant.
    const condition =
      valueType === "date" && isDateOnlyValue(value)
        ? compileDayCondition(valueColumn, "equals", value)
        : sql`${valueColumn} = ${value}`;

    return {
      sql: sql`
        EXISTS (
          SELECT 1
          FROM ${entityPropertyIndex}
          WHERE ${entityPropertyIndex.entityId} = ${entities.id}
            AND ${entityPropertyIndex.propertyDefId} IN ${propertyDefIds}
            AND ${condition}
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
    valueType: string,
    propertySlug: string
  ): CompiledFilter {
    const equalsFilter = this.buildIndexedEqualsFilterMultiProfile(
      propertyDefIds,
      value,
      valueType,
      propertySlug
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
    valueType: string,
    propertySlug: string
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
        return this.compileJSONBPropertyFilter(propertySlug, "in", values);
    }

    if (values.length === 0) {
      return { sql: sql`FALSE`, usesIndex: true };
    }

    return {
      sql: sql`
        EXISTS (
          SELECT 1
          FROM ${entityPropertyIndex}
          WHERE ${entityPropertyIndex.entityId} = ${entities.id}
            AND ${entityPropertyIndex.propertyDefId} IN ${propertyDefIds}
            AND ${valueColumn} IN ${values}
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

    const condition =
      valueType === "date" && isDateOnlyValue(value)
        ? compileDayCondition(valueColumn, operator, value)
        : sql`${valueColumn} ${sql.raw(sqlOperator)} ${value}`;

    return {
      sql: sql`
        EXISTS (
          SELECT 1
          FROM ${entityPropertyIndex}
          WHERE ${entityPropertyIndex.entityId} = ${entities.id}
            AND ${entityPropertyIndex.propertyDefId} IN ${propertyDefIds}
            AND ${condition}
        )
      `,
      usesIndex: true,
    };
  }

  /**
   * Compile filter for JSONB property (fallback when not indexed)
   *
   * Supports every `EntityFilter` operator. An operator or value shape it
   * cannot compile THROWS (like an unknown property in `compileFilter`; the
   * views router maps it to BAD_REQUEST) — it never degrades to `FALSE`,
   * which would render a broken filter as a calm, empty result.
   */
  private compileJSONBPropertyFilter(
    propertyKey: string,
    operator: string,
    value: unknown
  ): CompiledFilter {
    const propertiesCol = entities.properties;
    const text = sql`(${propertiesCol}->>${propertyKey})`;
    // Stored text cast to a timestamp behind a CASE guard: a value that is not
    // a date becomes NULL (no match) instead of aborting the query.
    const asTimestamp = sql`(CASE WHEN ${text} ~ ${ISO_DATE_TEXT_PATTERN} THEN ${text}::timestamptz END)`;

    // A date-only value compares by DAY (same rule as the indexed path).
    if (isDateOnlyValue(value)) {
      const day = compileDayCondition(asTimestamp, operator, value);
      if (day) return { sql: day, usesIndex: false };
    }

    switch (operator) {
      // `->>` yields TEXT, so the operand is bound as text. A JS boolean or
      // number is typed by postgres-js (bool / int / float8), and Postgres
      // has no `text = boolean` operator — the query would fail.
      case "equals":
        return {
          sql: sql`(${text} = ${filterText(value)})`,
          usesIndex: false,
        };
      case "not_equals":
        return {
          sql: negateIncludingMissing(sql`${text} = ${filterText(value)}`),
          usesIndex: false,
        };
      case "contains":
        return {
          sql: sql`(${text} ILIKE ${`%${value}%`})`,
          usesIndex: false,
        };
      case "not_contains":
        return {
          sql: negateIncludingMissing(sql`${text} ILIKE ${`%${value}%`}`),
          usesIndex: false,
        };
      // "Empty" = absent, JSON null, "" or []: what a reader means by a
      // blank field (a cleared text input stores "", a cleared multi-select
      // stores []). The indexed path has no is_empty of its own — every
      // property, indexed or not, is answered here, so this is the ONE rule.
      // Compared as jsonb, so a STRING "[]" is still a value. COALESCE keeps
      // is_not_empty a plain boolean (never NULL) for the absent key.
      case "is_empty":
        return {
          sql: sql`(${jsonbEmpty(propertiesCol, propertyKey)})`,
          usesIndex: false,
        };
      case "is_not_empty":
        return {
          sql: sql`(NOT ${jsonbEmpty(propertiesCol, propertyKey)})`,
          usesIndex: false,
        };
      case "in":
      case "not_in": {
        if (!Array.isArray(value)) {
          throw new Error(
            `Filter operator "${operator}" on property "${propertyKey}" requires an array value`
          );
        }
        // Empty set: nothing is IN it, everything is NOT IN it.
        if (value.length === 0) {
          return {
            sql: operator === "in" ? sql`FALSE` : sql`TRUE`,
            usesIndex: false,
          };
        }
        // `->>` yields text, so compare against text. Drizzle expands a JS
        // array into a parenthesised param list `($1, $2)` — valid for IN,
        // NOT valid inside ANY(), which needs a single array value.
        const texts = value.map((v) => String(v));
        return {
          sql:
            operator === "in"
              ? sql`(${text} IN ${texts})`
              : negateIncludingMissing(sql`${text} IN ${texts}`),
          usesIndex: false,
        };
      }
      case "greater_than":
      case "greater_than_or_equal":
      case "less_than":
      case "less_than_or_equal": {
        // Mirrors the indexed range path: numbers compare as numeric, dates
        // as timestamps. The JSONB path has no valueType, so the kind comes
        // from the filter value. The CASE guard keeps a stored value that is
        // not of that kind from aborting the whole query on a cast error —
        // it becomes NULL and simply does not match.
        const sqlOperator = RANGE_SQL_OPERATORS[operator] as string;
        if (isNumericFilterValue(value)) {
          return {
            sql: sql`(CASE WHEN ${text} ~ ${NUMERIC_TEXT_PATTERN} THEN ${text}::numeric END ${sql.raw(sqlOperator)} ${String(Number(value))}::numeric)`,
            usesIndex: false,
          };
        }
        if (typeof value === "string" && ISO_DATE_PREFIX.test(value)) {
          return {
            sql: sql`(${asTimestamp} ${sql.raw(sqlOperator)} ${value}::timestamptz)`,
            usesIndex: false,
          };
        }
        throw new Error(
          `Filter operator "${operator}" on property "${propertyKey}" requires a number or an ISO date value`
        );
      }
      default:
        throw new Error(
          `Unsupported filter operator "${operator}" on property "${propertyKey}"`
        );
    }
  }
}

const RANGE_SQL_OPERATORS: Record<string, string> = {
  greater_than: ">",
  greater_than_or_equal: ">=",
  less_than: "<",
  less_than_or_equal: "<=",
};
/** Stored text the numeric range comparison will cast (else it is NULL). */
const NUMERIC_TEXT_PATTERN = "^\\s*-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?\\s*$";
/** Stored text the date range comparison will cast (else it is NULL). */
const ISO_DATE_TEXT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}";
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** `YYYY-MM-DD` exactly — a calendar day, not an instant. */
const DATE_ONLY_VALUE = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnlyValue(value: unknown): value is string {
  return typeof value === "string" && DATE_ONLY_VALUE.test(value);
}

/**
 * DAY semantics for a date-only value against a timestamp expression:
 * "is" = within that day, "before"/"after" exclude the whole day,
 * "on or before"/"on or after" include it. The day is bounded in the
 * session time zone (`'YYYY-MM-DD'::date` → timestamptz), the same zone a
 * stored date-only string is cast in, so stored days line up exactly.
 * Returns null for an operator that has no day meaning (caller falls through).
 */
function compileDayCondition(
  ts: unknown,
  operator: string,
  day: string
): SQL | null {
  const start = sql`(${day}::date)::timestamptz`;
  const end = sql`(${day}::date + 1)::timestamptz`;
  const within = sql`(${ts} >= ${start} AND ${ts} < ${end})`;
  switch (operator) {
    case "equals":
      return within;
    case "not_equals":
      return negateIncludingMissing(within);
    case "greater_than":
      return sql`(${ts} >= ${end})`;
    case "greater_than_or_equal":
      return sql`(${ts} >= ${start})`;
    case "less_than":
      return sql`(${ts} < ${start})`;
    case "less_than_or_equal":
      return sql`(${ts} < ${end})`;
    default:
      return null;
  }
}

/**
 * Negation that INCLUDES rows whose value is missing / NULL / not comparable
 * (Notion / Linear: "is not X" lists the items with no value). Plain SQL
 * `x != v` is NULL — excluded — for a missing key, which made the JSONB path
 * disagree with the indexed path's `NOT EXISTS`.
 */
function negateIncludingMissing(positive: SQL): SQL {
  return sql`(NOT COALESCE(${positive}, FALSE))`;
}

/**
 * A property reads as EMPTY when it is absent, JSON null, "" or [] — compared
 * as jsonb, never as `->>` text, so a stored string "[]" stays a value.
 */
function jsonbEmpty(
  propertiesCol: typeof entities.properties,
  propertyKey: string
): SQL {
  return sql`COALESCE(${propertiesCol}->${propertyKey}, 'null'::jsonb) IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb)`;
}

/** The text operand for comparing against `->>` output. */
function filterText(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function requiresArray(operator: string, field: string): Error {
  return new Error(
    `Filter operator "${operator}" on field "${field}" requires an array value`
  );
}

function isNumericFilterValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number(value));
  }
  return false;
}
