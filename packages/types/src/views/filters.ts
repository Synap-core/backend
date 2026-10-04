/**
 * VIEW FILTER GRAMMAR — the ONE operator vocabulary for `views.query.filters`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three operator dialects grew around view filters: the backend
 * `FilterOperator` union, the table executor's (`gt`/`gte`/`notIn`/`between`),
 * and whatever a surface wrote (`ViewPage` wrote `eq`, which nothing could
 * compile). Which operators a property may be filtered with was answered by a
 * `switch` in synap-app (`operatorsForType`, view-renderer
 * `FilterControls.tsx`) keyed by UI value types (`select`, `datetime`, `text`)
 * the backend does not have. And the views tRPC doors accepted `filters` as
 * `z.any()`, so a malformed filter was stored, then failed at execute time.
 *
 * This module is the single answer to all three:
 *   - `VIEW_FILTER_OPERATORS` — the canonical operator set (`FilterOperator`
 *     is DERIVED from it, never re-listed);
 *   - `VIEW_FILTER_OPERATORS_BY_VALUE_TYPE` — which operators a property of a
 *     given `PropertyValueType` (the property-def enum) may offer;
 *   - `VIEW_FILTER_VALUE_SHAPE` — what value each operator takes;
 *   - `ViewFilterSchema` / `ViewFiltersSchema` — the zod door, which also
 *     normalises the legacy aliases (`eq` → `equals` …) so stored data written
 *     in an old dialect keeps working.
 *
 * Labels are NOT here: they are vocabulary (`resolveFilterOperatorLabel` in
 * `@synap-core/types/vocabulary`).
 *
 * ⚠️ MIRRORED by `@synap/database`'s `VIEW_FILTER_OPERATORS`
 * (`services/view-filter-compiler.ts`). The compiler cannot import this file —
 * `@synap-core/types` depends on `@synap/database`, so the reverse import is a
 * build cycle (same precedent as `GUIDELINE_SCOPE_ORDER`). The parity +
 * every-operator-compiles tripwire lives at
 * `packages/database/src/services/view-filter-operators-parity.test.ts`.
 *
 * Pure: depends only on zod. Safe in browser, Electron, Node and relay.
 */

import { z } from "zod";
import type { PropertyValueType } from "../profiles/index.js";

/** The canonical operator set, in menu order. */
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

/** A view filter operator. Derived from {@link VIEW_FILTER_OPERATORS}. */
export type FilterOperator = (typeof VIEW_FILTER_OPERATORS)[number];

/**
 * What value an operator takes:
 *   - `single` — one string / number / boolean (`equals`, `contains`, ranges);
 *   - `multi`  — a list of them (`in`, `not_in`);
 *   - `none`   — no value at all (`is_empty`, `is_not_empty`).
 *
 * A picker reads this to decide which editor to mount; the zod door enforces
 * it, because the compiler throws on `in` with a non-array.
 */
export type ViewFilterValueShape = "single" | "multi" | "none";

export const VIEW_FILTER_VALUE_SHAPE: Readonly<
  Record<FilterOperator, ViewFilterValueShape>
> = {
  equals: "single",
  not_equals: "single",
  contains: "single",
  not_contains: "single",
  in: "multi",
  not_in: "multi",
  greater_than: "single",
  greater_than_or_equal: "single",
  less_than: "single",
  less_than_or_equal: "single",
  is_empty: "none",
  is_not_empty: "none",
};

/**
 * `PropertyValueType` → the operators a filter on such a property may offer,
 * in menu order. A `Record` over the closed property-def enum, so a new value
 * type is a BUILD error here rather than silently falling into a default.
 *
 * Each row offers only what the compiler (indexed AND JSONB paths) evaluates
 * meaningfully for that type — never a control that cannot match:
 *   - `boolean`: no ranges / substring — `true > false` is not a question.
 *   - `date`: no `in` — exact-instant set membership is not how people ask
 *     about dates; ranges carry the meaning (labelled before/after).
 *   - `entity_id`: identity only — a UUID substring is meaningless.
 *   - `array`: stored as JSON, read as text by the JSONB path, so only the
 *     substring test means something — plus `is_empty`, which the compiler
 *     reads as absent, null, "" or `[]`.
 *   - `object`: present / absent only.
 *   - `secret`: none. Filtering is an oracle over the value; a secret is never
 *     offered as a filter field.
 */
export const VIEW_FILTER_OPERATORS_BY_VALUE_TYPE: Readonly<
  Record<PropertyValueType, readonly FilterOperator[]>
> = {
  string: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "in",
    "not_in",
    "is_empty",
    "is_not_empty",
  ],
  number: [
    "equals",
    "not_equals",
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
    "in",
    "not_in",
    "is_empty",
    "is_not_empty",
  ],
  boolean: ["equals", "not_equals", "is_empty", "is_not_empty"],
  date: [
    "equals",
    "not_equals",
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
    "is_empty",
    "is_not_empty",
  ],
  entity_id: [
    "equals",
    "not_equals",
    "in",
    "not_in",
    "is_empty",
    "is_not_empty",
  ],
  array: ["contains", "not_contains", "is_empty", "is_not_empty"],
  object: ["is_empty", "is_not_empty"],
  secret: [],
};

/**
 * The operators for a value type. An unknown type (a UI-only alias, a future
 * enum value read by an old client) gets `string`'s set — the JSONB path reads
 * every value as text, so the text operators are the ones that always compile.
 */
export function viewFilterOperatorsFor(
  valueType: string | null | undefined
): readonly FilterOperator[] {
  return (
    (
      VIEW_FILTER_OPERATORS_BY_VALUE_TYPE as Readonly<
        Record<string, readonly FilterOperator[]>
      >
    )[valueType ?? ""] ?? VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.string
  );
}

/**
 * Legacy operator spellings → canonical. Only dialects that have actually
 * been written: `eq` (browser `ViewPage` before dc55107), `is` (stored in
 * view `config.filterBy` on live pods) with its negation `is_not`, and the
 * table executor's `gt`/`gte`/`lt`/`lte`/`notIn` (`@synap-core/table-view`).
 * The table executor's `between` has NO canonical equivalent and is rejected.
 */
export const LEGACY_VIEW_FILTER_OPERATOR_ALIASES: Readonly<
  Record<string, FilterOperator>
> = {
  eq: "equals",
  is: "equals",
  is_not: "not_equals",
  gt: "greater_than",
  gte: "greater_than_or_equal",
  lt: "less_than",
  lte: "less_than_or_equal",
  notIn: "not_in",
};

/** Canonical spelling of an operator; anything unknown is returned as-is. */
export function normalizeViewFilterOperator(operator: string): string {
  return LEGACY_VIEW_FILTER_OPERATOR_ALIASES[operator] ?? operator;
}

/**
 * Rewrite a filter's legacy operator to its canonical spelling, leaving
 * everything else untouched. LENIENT on purpose: the read path (`views.execute`
 * over stored rows) uses it so old data keeps compiling, and an operator that
 * is not an alias passes through for the compiler to reject by name.
 */
export function normalizeViewFilter<T>(filter: T): T {
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    return filter;
  }
  const operator: unknown = (filter as Record<string, unknown>).operator;
  if (typeof operator !== "string") return filter;
  const canonical = normalizeViewFilterOperator(operator);
  return canonical === operator
    ? filter
    : ({ ...filter, operator: canonical } as T);
}

const FilterScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The entity columns a filter may name directly. Anything else is a property
 * and must be spelled `properties.<slug>` — a bare `status` names nothing the
 * compiler can read, and used to compile to "no condition" (every row back,
 * looking filtered). MIRRORED by the compiler's `VIEW_FILTER_CORE_FIELDS`
 * (same parity tripwire as the operators).
 */
export const VIEW_FILTER_CORE_FIELDS = [
  "title",
  "preview",
  "type",
  "createdAt",
  "updatedAt",
] as const;

const PROPERTY_FIELD = /^properties\.[^.]+$/;

/** A field the compiler can evaluate: a core column or `properties.<slug>`. */
export function isViewFilterField(field: string): boolean {
  return (
    (VIEW_FILTER_CORE_FIELDS as readonly string[]).includes(field) ||
    PROPERTY_FIELD.test(field)
  );
}

/**
 * One view filter, as stored in `views.query.filters` and sent to
 * `views.execute`. Legacy operator aliases are normalised BEFORE validation;
 * an unknown operator, or a value of the wrong shape for its operator, is
 * rejected.
 *
 * `field` is `title` / `preview` / `type` / `createdAt` / `updatedAt` or
 * `properties.<slug>`.
 */
export const ViewFilterSchema = z.preprocess(
  normalizeViewFilter,
  z
    .object({
      field: z.string().refine(isViewFilterField, {
        message: `Filter field must be one of ${VIEW_FILTER_CORE_FIELDS.join(", ")} or "properties.<slug>"`,
      }),
      operator: z.enum(VIEW_FILTER_OPERATORS),
      value: z.unknown().optional(),
    })
    .superRefine((filter, ctx) => {
      const shape = VIEW_FILTER_VALUE_SHAPE[filter.operator];
      const ok =
        shape === "none"
          ? true
          : shape === "multi"
            ? z.array(FilterScalarSchema).safeParse(filter.value).success
            : FilterScalarSchema.safeParse(filter.value).success;
      if (!ok) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message:
            shape === "multi"
              ? `Filter operator "${filter.operator}" takes a list of values`
              : `Filter operator "${filter.operator}" takes one string, number or boolean value`,
        });
      }
    })
);

/** A view's filter list (flat AND). */
export const ViewFiltersSchema = z.array(ViewFilterSchema);

export type ViewFilter = z.infer<typeof ViewFilterSchema>;

// ─── Stored-filter repair (legacy rows) ─────────────────────────────────────

/** A stored filter that could not be repaired into the grammar, and why. */
export interface DroppedViewFilter {
  filter: unknown;
  reason: string;
}

/**
 * Rewrite ONE stored filter from a legacy dialect into the grammar. Only
 * repairs whose meaning is unambiguous, each a dialect that has been written:
 *   - operator aliases (`eq`, `is`, `gte`, `notIn` …);
 *   - `metadata.<key>` → `properties.<key>` (the table executor read both
 *     from the properties bag);
 *   - `in` / `not_in` with one scalar → a one-item list;
 *   - `equals` / `not_equals` with a list → that scalar (one item) or
 *     `in` / `not_in` (several);
 *   - the table executor's inclusive `between [a, b]` → `>= a` AND `<= b`.
 * Returns the repaired filter(s); the caller still validates them.
 */
export function repairLegacyViewFilter(raw: unknown): unknown[] {
  const normalised = normalizeViewFilter(raw);
  if (
    normalised === null ||
    typeof normalised !== "object" ||
    Array.isArray(normalised)
  ) {
    return [normalised];
  }
  const filter = { ...(normalised as Record<string, unknown>) };
  if (
    typeof filter.field === "string" &&
    filter.field.startsWith("metadata.")
  ) {
    filter.field = `properties.${filter.field.slice("metadata.".length)}`;
  }
  const { operator, value } = filter;
  if (
    (operator === "in" || operator === "not_in") &&
    FilterScalarSchema.safeParse(value).success
  ) {
    return [{ ...filter, value: [value] }];
  }
  if (
    (operator === "equals" || operator === "not_equals") &&
    Array.isArray(value)
  ) {
    return value.length === 1
      ? [{ ...filter, value: value[0] }]
      : [{ ...filter, operator: operator === "equals" ? "in" : "not_in" }];
  }
  if (operator === "between" && Array.isArray(value) && value.length === 2) {
    return [
      { ...filter, operator: "greater_than_or_equal", value: value[0] },
      { ...filter, operator: "less_than_or_equal", value: value[1] },
    ];
  }
  return [filter];
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

/**
 * LENIENT read of a stored filter list: repair what is repairable, validate
 * the result, and DROP (with the reason) what still is not in the grammar —
 * never fail the whole set over one old row. The caller must surface
 * `dropped` (log + response): a dropped filter widens the result.
 */
export function sanitizeStoredViewFilters(raw: unknown): {
  filters: ViewFilter[];
  dropped: DroppedViewFilter[];
} {
  const filters: ViewFilter[] = [];
  const dropped: DroppedViewFilter[] = [];
  if (raw === undefined || raw === null) return { filters, dropped };
  if (!Array.isArray(raw)) {
    return {
      filters,
      dropped: [{ filter: raw, reason: "Stored filters are not a list" }],
    };
  }
  for (const stored of raw) {
    for (const candidate of repairLegacyViewFilter(stored)) {
      const parsed = ViewFilterSchema.safeParse(candidate);
      if (parsed.success) filters.push(parsed.data);
      else
        dropped.push({ filter: stored, reason: describeIssues(parsed.error) });
    }
  }
  return { filters, dropped };
}

/** Key-order-independent identity of a filter (stored JSONB reorders keys). */
function filterIdentity(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : v
  );
}

/**
 * Validate an INCOMING filter list (a `views.update` save, or `views.execute`
 * ephemeral filters) against the view's STORED filters. A client holds the
 * full effective set — stored rows included — and sends it back, so one old
 * stored row the grammar now refuses would otherwise block every edit and
 * every save of that view:
 *   - a filter valid in the grammar is kept;
 *   - an invalid filter that IS one of the view's stored rows is repaired
 *     (`sanitizeStoredViewFilters` rules) or, if unrepairable, dropped and
 *     reported — it predates the door, the user did not just author it;
 *   - an invalid filter that is NOT stored is `rejected`: new input must be
 *     in the grammar (the caller answers BAD_REQUEST).
 */
export function resolveIncomingViewFilters(
  incoming: readonly unknown[],
  stored: unknown
): {
  filters: ViewFilter[];
  dropped: DroppedViewFilter[];
  rejected: DroppedViewFilter[];
} {
  const storedIds = new Set(
    Array.isArray(stored) ? stored.map(filterIdentity) : []
  );
  const filters: ViewFilter[] = [];
  const dropped: DroppedViewFilter[] = [];
  const rejected: DroppedViewFilter[] = [];
  for (const filter of incoming) {
    const parsed = ViewFilterSchema.safeParse(filter);
    if (parsed.success) {
      filters.push(parsed.data);
      continue;
    }
    if (storedIds.has(filterIdentity(filter))) {
      const repaired = sanitizeStoredViewFilters([filter]);
      filters.push(...repaired.filters);
      dropped.push(...repaired.dropped);
      continue;
    }
    rejected.push({ filter, reason: describeIssues(parsed.error) });
  }
  return { filters, dropped, rejected };
}
