import { describe, it, expect } from "vitest";
import {
  VIEW_FILTER_OPERATORS,
  VIEW_FILTER_OPERATORS_BY_VALUE_TYPE,
  VIEW_FILTER_VALUE_SHAPE,
  LEGACY_VIEW_FILTER_OPERATOR_ALIASES,
  ViewFilterSchema,
  ViewFiltersSchema,
  normalizeViewFilter,
  viewFilterOperatorsFor,
  VIEW_FILTER_CORE_FIELDS,
  isViewFilterField,
  repairLegacyViewFilter,
  sanitizeStoredViewFilters,
  resolveIncomingViewFilters,
  type FilterOperator,
} from "./filters.js";
import { PropertyDefSchema } from "../profiles/index.js";

/** A valid value for each shape — derived from the shape table, not per op. */
function sampleValue(op: FilterOperator): unknown {
  const shape = VIEW_FILTER_VALUE_SHAPE[op];
  return shape === "multi" ? ["a", 2] : shape === "none" ? undefined : "a";
}

describe("view filter grammar (@synap-core/types/views)", () => {
  it("non-vacuity: twelve canonical operators", () => {
    expect(VIEW_FILTER_OPERATORS).toHaveLength(12);
  });

  it("every operator has a value shape", () => {
    expect(Object.keys(VIEW_FILTER_VALUE_SHAPE).sort()).toEqual(
      [...VIEW_FILTER_OPERATORS].sort()
    );
  });

  it("the per-type table covers exactly the property-def value types", () => {
    // Derived from the property-def zod enum, so a new value type fails here.
    const valueTypes = PropertyDefSchema.shape.valueType.options;
    expect(valueTypes.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(VIEW_FILTER_OPERATORS_BY_VALUE_TYPE).sort()).toEqual(
      [...valueTypes].sort()
    );
  });

  it("every per-type operator is canonical, and secret offers none", () => {
    for (const ops of Object.values(VIEW_FILTER_OPERATORS_BY_VALUE_TYPE)) {
      for (const op of ops) expect(VIEW_FILTER_OPERATORS).toContain(op);
    }
    expect(VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.secret).toEqual([]);
    expect(VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.date).not.toContain("in");
    expect(VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.array).toContain("is_empty");
  });

  it("an unknown value type falls back to the string operators", () => {
    expect(viewFilterOperatorsFor("select")).toBe(
      VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.string
    );
    expect(viewFilterOperatorsFor(undefined)).toBe(
      VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.string
    );
    expect(viewFilterOperatorsFor("date")).toBe(
      VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.date
    );
  });

  it("accepts every canonical operator with a value of its shape", () => {
    for (const op of VIEW_FILTER_OPERATORS) {
      const parsed = ViewFilterSchema.safeParse({
        field: "properties.status",
        operator: op,
        value: sampleValue(op),
      });
      expect(parsed.success, op).toBe(true);
    }
  });

  it("accepts number and boolean single values", () => {
    expect(
      ViewFilterSchema.safeParse({
        field: "properties.x",
        operator: "equals",
        value: 5,
      }).success
    ).toBe(true);
    expect(
      ViewFilterSchema.safeParse({
        field: "properties.x",
        operator: "not_equals",
        value: false,
      }).success
    ).toBe(true);
  });

  it("rejects unknown operators, including the table dialect's `between`", () => {
    for (const operator of ["between", "bogus", "$eq", "EQUALS"]) {
      expect(
        ViewFilterSchema.safeParse({
          field: "properties.x",
          operator,
          value: "a",
        }).success,
        operator
      ).toBe(false);
    }
  });

  it("rejects a value of the wrong shape for its operator", () => {
    const bad = [
      { field: "properties.x", operator: "in", value: "open" },
      { field: "properties.x", operator: "not_in", value: [{ a: 1 }] },
      { field: "properties.x", operator: "equals" },
      { field: "properties.x", operator: "equals", value: null },
      { field: "properties.x", operator: "contains", value: ["a"] },
      { field: "", operator: "equals", value: "a" },
    ];
    for (const filter of bad) {
      expect(
        ViewFilterSchema.safeParse(filter).success,
        JSON.stringify(filter)
      ).toBe(false);
    }
  });

  it("normalises every legacy alias to its canonical operator at the parse boundary", () => {
    const aliases = Object.entries(LEGACY_VIEW_FILTER_OPERATOR_ALIASES);
    expect(aliases.length).toBeGreaterThanOrEqual(8); // non-vacuity
    for (const [legacy, canonical] of aliases) {
      const value = sampleValue(canonical);
      const parsed = ViewFilterSchema.parse({
        field: "properties.x",
        operator: legacy,
        value,
      });
      expect(parsed.operator, legacy).toBe(canonical);
    }
    expect(
      ViewFiltersSchema.parse([{ field: "title", operator: "eq", value: "a" }])
    ).toEqual([{ field: "title", operator: "equals", value: "a" }]);
  });

  it("the lenient read-path normaliser leaves non-aliases untouched", () => {
    const keep = { field: "properties.x", operator: "between", value: [1, 2] };
    expect(normalizeViewFilter(keep)).toBe(keep);
    expect(normalizeViewFilter(null)).toBe(null);
    expect(
      normalizeViewFilter({ field: "properties.x", operator: "gte", value: 1 })
    ).toEqual({
      field: "properties.x",
      operator: "greater_than_or_equal",
      value: 1,
    });
  });

  it("field: core columns or properties.<slug>, nothing else", () => {
    for (const field of [...VIEW_FILTER_CORE_FIELDS, "properties.status"]) {
      expect(isViewFilterField(field), field).toBe(true);
      expect(
        ViewFilterSchema.safeParse({ field, operator: "is_empty" }).success,
        field
      ).toBe(true);
    }
    for (const field of [
      "status",
      "metadata.status",
      "properties.",
      "properties.a.b",
      "Title",
    ]) {
      expect(isViewFilterField(field), field).toBe(false);
      expect(
        ViewFilterSchema.safeParse({ field, operator: "is_empty" }).success,
        field
      ).toBe(false);
    }
  });
});

describe("stored-filter repair (legacy rows)", () => {
  it("repairs every written legacy shape into the grammar", () => {
    const cases: Array<[unknown, unknown[]]> = [
      [
        { field: "properties.s", operator: "in", value: "open" },
        [{ field: "properties.s", operator: "in", value: ["open"] }],
      ],
      [
        { field: "properties.s", operator: "notIn", value: "open" },
        [{ field: "properties.s", operator: "not_in", value: ["open"] }],
      ],
      [
        { field: "properties.s", operator: "eq", value: ["open"] },
        [{ field: "properties.s", operator: "equals", value: "open" }],
      ],
      [
        { field: "properties.s", operator: "not_equals", value: ["a", "b"] },
        [{ field: "properties.s", operator: "not_in", value: ["a", "b"] }],
      ],
      [
        { field: "properties.n", operator: "between", value: [1, 5] },
        [
          {
            field: "properties.n",
            operator: "greater_than_or_equal",
            value: 1,
          },
          { field: "properties.n", operator: "less_than_or_equal", value: 5 },
        ],
      ],
      [
        { field: "metadata.s", operator: "is", value: "x" },
        [{ field: "properties.s", operator: "equals", value: "x" }],
      ],
    ];
    for (const [legacy, expected] of cases) {
      expect(repairLegacyViewFilter(legacy), JSON.stringify(legacy)).toEqual(
        expected
      );
      expect(
        sanitizeStoredViewFilters([legacy]),
        JSON.stringify(legacy)
      ).toEqual({ filters: expected, dropped: [] });
    }
  });

  it("drops (with a reason) what it cannot repair, keeping the rest", () => {
    const keep = { field: "title", operator: "equals", value: "a" };
    const bare = { field: "status", operator: "equals", value: "a" };
    const bogus = { field: "title", operator: "bogus", value: "a" };
    const out = sanitizeStoredViewFilters([keep, bare, bogus]);
    expect(out.filters).toEqual([keep]);
    expect(out.dropped.map((d) => d.filter)).toEqual([bare, bogus]);
    expect(out.dropped[0]?.reason).toMatch(/Filter field must be/);
    expect(sanitizeStoredViewFilters(undefined)).toEqual({
      filters: [],
      dropped: [],
    });
    expect(sanitizeStoredViewFilters({}).dropped).toHaveLength(1);
  });

  it("incoming: valid kept, stored-invalid repaired/dropped, NEW invalid rejected", () => {
    const storedBetween = {
      operator: "between",
      value: [1, 5],
      field: "properties.n",
    };
    const storedBare = { field: "status", operator: "equals", value: "a" };
    const stored = [storedBetween, storedBare];
    const valid = { field: "title", operator: "contains", value: "x" };
    const newBad = { field: "properties.s", operator: "in", value: "open" };
    const out = resolveIncomingViewFilters(
      // Key order differs from the stored JSONB on purpose.
      [
        valid,
        { field: "properties.n", operator: "between", value: [1, 5] },
        { ...storedBare },
        newBad,
      ],
      stored
    );
    expect(out.filters).toEqual([
      valid,
      { field: "properties.n", operator: "greater_than_or_equal", value: 1 },
      { field: "properties.n", operator: "less_than_or_equal", value: 5 },
    ]);
    expect(out.dropped.map((d) => d.filter)).toEqual([storedBare]);
    expect(out.rejected.map((d) => d.filter)).toEqual([newBad]);
    expect(out.rejected[0]?.reason).toMatch(/takes a list of values/);
  });
});
