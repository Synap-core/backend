/**
 * The `query` node's filter/orderBy DSL — parsing + SQL compilation. Extracted
 * as a leaf: depends only on `@synap/database` and `template-resolve.ts` (never
 * on the worker or another `steps/*` module) so `steps/query.ts` can build on
 * it without pulling in the rest of the executor.
 */
import {
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  entities,
  drizzleSql,
} from "@synap/database";
import type { Column, SQL } from "@synap/database";
import { TRIGGER_FILTER_OPERATORS } from "@synap-core/types/automations/filter-operators";
import { resolveTemplate } from "./template-resolve.js";
import { logger } from "./automation-executor-logger.js";
import type { StepContext } from "./automation-executor-types.js";

/** A query node's filter can carry a plain equality value or a `$gt`/`$gte`/
 * `$lt`/`$lte`/`$ne` operator object (the shape AI-authored flows emit for
 * numeric thresholds, e.g. `{ "properties.strengthScore": { "$gt": 30 } }`). */
type QueryFilterOperator = "eq" | "gt" | "gte" | "lt" | "lte" | "ne";

export interface QueryPropertyCondition {
  propKey: string;
  op: QueryFilterOperator;
  value: unknown;
}

/**
 * A filter term that addresses a real `entities` COLUMN rather than a key
 * inside the `properties` jsonb. See `QUERY_COLUMNS` for why this exists.
 *
 * SHAPE NOTE: the two variants are discriminated by the PRESENCE of `column`
 * (narrowed with `"column" in condition`), not by a `kind` tag. That is
 * deliberate — `QueryPropertyCondition` keeps the exact `{ propKey, op, value }`
 * shape it has always had, so nothing that reads the output of
 * `parseQueryFilterConditions` changes meaning or needs a new field.
 * `QueryOrderBy` can afford a `kind` tag because its two arms carry genuinely
 * different payloads (a Drizzle column object vs a string key); here they don't.
 */
export interface QueryColumnCondition {
  column: QueryColumnName;
  op: QueryFilterOperator;
  /**
   * Already coerced to the column's own type at PARSE time: a `Date` for the
   * timestamp columns, the raw value for the text ones. Coercing in the parser
   * (rather than at SQL-build time) is what lets an un-parseable date be
   * DROPPED instead of compiled into a wrong comparison.
   */
  value: unknown;
}

export type QueryCondition = QueryPropertyCondition | QueryColumnCondition;

/**
 * The `$`-operators this SQL compiler implements, keyed by the SHARED
 * vocabulary in `@synap-core/types/automations/filter-operators`
 * (`TRIGGER_FILTER_OPERATORS`) — the same names the automation TRIGGER filters
 * use and the create door validates. One vocabulary, two evaluators (SQL here,
 * in-memory there); see that module's header for why the implementations cannot
 * be shared.
 *
 * `$eq` maps to the same `eq` a plain (non-object) filter value produces — it
 * was missing before 2026-08-16, so `{ x: { $eq: "v" } }` in a query node hit
 * the `!op` branch and was DROPPED silently, quietly widening the result set.
 * `$in` is deliberately absent: compiling it would need an `ANY`/`inArray` over
 * a jsonb text extraction, which is beyond this change. It is not silent — an
 * operator in the shared vocabulary that this compiler does not implement is
 * logged below rather than dropped invisibly.
 */
const QUERY_FILTER_OPERATORS: Record<string, QueryFilterOperator> = {
  $eq: "eq",
  $gt: "gt",
  $gte: "gte",
  $lt: "lt",
  $lte: "lte",
  $ne: "ne",
};

/** Strip a redundant leading "properties." some flow authors include on a
 * filter/orderBy key — entity properties are the implicit namespace here. */
function stripPropertiesPrefix(key: string): string {
  return key.startsWith("properties.") ? key.slice("properties.".length) : key;
}

function asQueryFilterObject(
  filter: unknown
): Record<string, unknown> | undefined {
  if (filter && typeof filter === "object" && !Array.isArray(filter)) {
    return filter as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Resolve the profileSlug for a query node. The node contract documents a
 * top-level `profileSlug` field, but AI-authored flows sometimes nest it
 * inside `filter.profileSlug` instead (e.g. `filter: { profileSlug: "person",
 * "properties.strengthScore": { $gt: 30 } }`) — the top-level field is then
 * `undefined`, and calling `resolveTemplate(undefined, …)` crashed with
 * "Cannot read properties of undefined (reading 'replace')" (`String.replace`
 * called on the missing value). Check both locations before resolving.
 */
export function resolveQueryProfileSlug(
  data: { profileSlug?: unknown; filter?: unknown },
  context: StepContext
): string {
  const filterObj = asQueryFilterObject(data.filter);
  const raw =
    (filterObj && typeof filterObj.profileSlug === "string"
      ? filterObj.profileSlug
      : undefined) ??
    (typeof data.profileSlug === "string" ? data.profileSlug : undefined);
  return raw ? resolveTemplate(raw, context) : "";
}

/**
 * Parse a query node's `filter` into property conditions. Supports both the
 * legacy shape — a JSON-stringified flat `{ propertyKey: value }` equality
 * map, resolved via template first — and the object shape AI-authored flows
 * emit directly (`{ profileSlug, "properties.<key>": value | { $gt, … } }`).
 * `profileSlug` is resolved separately (`resolveQueryProfileSlug`) and
 * skipped here. Never throws: an unparseable/empty filter yields `[]`.
 *
 * KEY RESOLUTION — identical precedence to `parseQueryOrderBy`, on purpose, so
 * the two halves of a query node mean the same thing by the same name:
 *  1. An explicit `properties.` prefix ALWAYS means the jsonb blob. The escape
 *     hatch for a workspace whose entities genuinely carry a property called
 *     `updatedAt`.
 *  2. A bare name in `QUERY_COLUMNS` means the real `entities` COLUMN.
 *  3. Anything else is a jsonb property key — what every existing flow already
 *     relies on, so nothing that works today changes meaning.
 *
 * A date-column term whose value will not parse as a date is DROPPED here (see
 * `coerceDateFilterValue`) rather than emitted as a broken comparison.
 */
export function parseQueryFilterConditions(
  filter: unknown,
  context: StepContext
): QueryCondition[] {
  let filterObj = asQueryFilterObject(filter);
  if (!filterObj && typeof filter === "string") {
    const resolved = resolveTemplate(filter, context);
    if (resolved) {
      try {
        filterObj = JSON.parse(resolved) as Record<string, unknown>;
      } catch {
        filterObj = undefined; // unparseable filter — ignore, return unfiltered (defensive)
      }
    }
  }
  if (!filterObj) return [];

  const conditions: QueryCondition[] = [];
  const push = (
    rawKey: string,
    column: QueryColumnName | undefined,
    propKey: string,
    op: QueryFilterOperator,
    value: unknown
  ) => {
    if (!column) {
      conditions.push({ propKey, op, value });
      return;
    }
    if (!QUERY_DATE_COLUMNS.has(column)) {
      conditions.push({ column, op, value });
      return;
    }
    const date = coerceDateFilterValue(value);
    if (!date) {
      logger.warn(
        { filterKey: rawKey, op, value },
        "query node: dropping date-column filter — value is not a parseable date (ISO-8601 string, epoch millis or Date expected)"
      );
      return;
    }
    conditions.push({ column, op, value: date });
  };

  for (const [rawKey, rawValue] of Object.entries(filterObj)) {
    if (rawKey === "profileSlug" || rawValue === undefined || rawValue === null)
      continue;
    // Precedence 1+2: an explicit `properties.` prefix pins the key to jsonb;
    // only a BARE name is eligible to resolve to a real column.
    const column = rawKey.startsWith("properties.")
      ? undefined
      : QUERY_COLUMNS[rawKey as QueryColumnName]
        ? (rawKey as QueryColumnName)
        : undefined;
    const propKey = stripPropertiesPrefix(rawKey);
    if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
      for (const [opKey, opValue] of Object.entries(
        rawValue as Record<string, unknown>
      )) {
        const op = QUERY_FILTER_OPERATORS[opKey];
        if (!op) {
          // A dropped term WIDENS the result set, which is at least visible —
          // but dropping it silently is how `$eq` went unnoticed. Say so.
          logger.warn(
            { filterKey: rawKey, operator: opKey },
            TRIGGER_FILTER_OPERATORS.includes(
              opKey as (typeof TRIGGER_FILTER_OPERATORS)[number]
            )
              ? "query node: dropping filter term — operator is in the shared filter vocabulary but is not compiled to SQL by the query node"
              : "query node: dropping filter term — unknown operator"
          );
          continue;
        }
        if (opValue === undefined || opValue === null) continue;
        push(rawKey, column, propKey, op, opValue);
      }
    } else {
      push(rawKey, column, propKey, "eq", rawValue);
    }
  }
  return conditions;
}

/**
 * Real `entities` COLUMNS a query node may address, mapped to their Drizzle
 * column. An allowlist, not a lookup: `orderBy`/`filter` keys are
 * author-supplied, and an open mapping into `entities` would let a flow read
 * or sort by any column in the table (including ones the SELECT does not
 * expose, e.g. `user_id`).
 *
 * `createdAt`/`updatedAt` are the reason this exists — they are timestamp
 * COLUMNS, never mirrored into the `properties` jsonb, so before this an
 * `orderBy: "updatedAt"` was silently read as the property `updatedAt`,
 * matched nothing, produced NULL for every row, and left the result in
 * arbitrary order WHILE LOOKING LIKE IT WORKED. That is the same
 * silently-wrong failure mode as the 2026-07-27 null-projection bug, so it
 * gets a real fix rather than a workaround.
 *
 * ONE ALLOWLIST FOR BOTH HALVES, deliberately (it was ORDER-only when the
 * ordering half was fixed; the FILTER half then shipped the identical bug —
 * `filter: { updatedAt: { $gt: … } }` compiled to `properties->>'updatedAt'`
 * and matched ZERO rows). Splitting it into an order-list and a filter-list
 * would let the two drift, and a key that is sortable but not filterable (or
 * the reverse) is a distinction no flow author can predict — the surprise IS
 * the bug class this fixes. Same names, same precedence, both halves.
 */
const QUERY_COLUMNS = {
  createdAt: entities.createdAt,
  updatedAt: entities.updatedAt,
  title: entities.title,
  type: entities.type,
} as const;

type QueryColumnName = keyof typeof QUERY_COLUMNS;

/**
 * Which of the allowlisted columns are `timestamp`s. Their filter values must
 * be bound as real `Date`s through Drizzle's typed operators — NEVER as
 * `Number(value)` (the old filter path's coercion, which yields NaN for every
 * ISO string) and NEVER interpolated into a `drizzleSql` template (a repo-wide
 * rule: binding a `Date` inside a template has caused live breakage; use
 * `gt()/gte()/lt()/lte()` instead).
 */
const QUERY_DATE_COLUMNS: ReadonlySet<QueryColumnName> = new Set([
  "createdAt",
  "updatedAt",
]);

/**
 * Coerce a filter value for a date column. Accepts an ISO-8601 string (the
 * shape flow authors and `{{now}}`-style templates emit), an epoch-millis
 * number, or an already-materialized `Date`.
 *
 * UN-PARSEABLE VALUES RETURN `undefined`, and the caller DROPS the condition
 * rather than binding `Invalid Date`. Dropping widens the result set, which is
 * visible; binding a broken date narrows it to zero rows silently — the exact
 * failure mode this whole change exists to kill. The drop is logged.
 */
export function coerceDateFilterValue(value: unknown): Date | undefined {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export type QueryOrderBy =
  | {
      kind: "column";
      column: (typeof QUERY_COLUMNS)[QueryColumnName];
      dir: "asc" | "desc";
    }
  | { kind: "property"; propKey: string; dir: "asc" | "desc" };

/**
 * Parse a query node's optional `orderBy`/`orderDir` fields. This is the
 * other half of the unresolved-path guard: a missing/non-string `orderBy`
 * yields `undefined` (no ordering applied) rather than ever reaching a
 * `.replace()` call on it.
 *
 * RESOLUTION ORDER, and why:
 *  1. An explicit `properties.` prefix ALWAYS means the jsonb blob. This is
 *     the escape hatch that keeps a workspace whose entities genuinely carry a
 *     property named `updatedAt` addressable and unambiguous.
 *  2. A bare name matching `QUERY_COLUMNS` means the real column.
 *  3. Anything else is a jsonb property key — the behavior every existing flow
 *     already relies on, so nothing that works today changes meaning.
 */
export function parseQueryOrderBy(data: {
  orderBy?: unknown;
  orderDir?: unknown;
}): QueryOrderBy | undefined {
  const raw = typeof data.orderBy === "string" ? data.orderBy.trim() : "";
  if (!raw) return undefined;
  const dir = data.orderDir === "asc" ? "asc" : "desc";

  if (!raw.startsWith("properties.")) {
    const column = QUERY_COLUMNS[raw as QueryColumnName];
    if (column) return { kind: "column", column, dir };
  }

  const propKey = stripPropertiesPrefix(raw);
  if (!propKey) return undefined;
  return { kind: "property", propKey, dir };
}

/** A JSONB property value compared/ordered numerically when it parses as a
 * plain number (so "9" doesn't rank above "30" lexicographically); rows
 * where it doesn't parse — a stored date/text value — fall out of numeric
 * comparisons (NULL) and are left to the caller's text-based fallback. */
export function numericPropertyExpr(propKey: string) {
  return drizzleSql`(CASE WHEN ${entities.properties}->>${propKey} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${entities.properties}->>${propKey})::numeric ELSE NULL END)`;
}

/**
 * Compile a COLUMN filter term. Uses Drizzle's typed operators rather than a
 * `drizzleSql` template on purpose: for the timestamp columns the bound value
 * is a real `Date`, and binding a `Date` inside a `drizzleSql` template is a
 * standing repo prohibition (it has broken production before) — `gt()/gte()/
 * lt()/lte()` bind it correctly through the column's own mapper. The text
 * columns go through the same operators for symmetry; `gt`/`lt` on them is
 * plain collation-ordered text comparison, which is well-defined.
 */
function columnConditionSql(condition: QueryColumnCondition): SQL {
  // Widened to the base `Column` on purpose: `QUERY_COLUMNS` is a UNION of four
  // differently-typed Drizzle columns, and TS intersects a union's operator
  // overloads down to `never`. The runtime binding is still the column's own
  // mapper — the widening only stops the compiler from demanding one concrete
  // column type. `value` is already coerced per column at parse time.
  const column = QUERY_COLUMNS[condition.column] as Column;
  const value = condition.value as Date | string;
  switch (condition.op) {
    case "eq":
      return eq(column, value);
    case "ne":
      return ne(column, value);
    case "gt":
      return gt(column, value);
    case "gte":
      return gte(column, value);
    case "lt":
      return lt(column, value);
    case "lte":
      return lte(column, value);
  }
}

export function queryConditionSql(condition: QueryCondition) {
  return "column" in condition
    ? columnConditionSql(condition)
    : propertyConditionSql(condition);
}

function propertyConditionSql(condition: QueryPropertyCondition) {
  const { propKey, op, value } = condition;
  if (op === "eq") {
    return drizzleSql`${entities.properties}->>${propKey} = ${String(value)}`;
  }
  if (op === "ne") {
    return drizzleSql`${entities.properties}->>${propKey} != ${String(value)}`;
  }
  const numericExpr = numericPropertyExpr(propKey);
  const numericValue = Number(value);
  switch (op) {
    case "gt":
      return drizzleSql`${numericExpr} > ${numericValue}`;
    case "gte":
      return drizzleSql`${numericExpr} >= ${numericValue}`;
    case "lt":
      return drizzleSql`${numericExpr} < ${numericValue}`;
    case "lte":
      return drizzleSql`${numericExpr} <= ${numericValue}`;
  }
}
