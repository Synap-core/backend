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
    expect(VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.array).not.toContain("is_empty");
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
      ViewFilterSchema.safeParse({ field: "x", operator: "equals", value: 5 })
        .success
    ).toBe(true);
    expect(
      ViewFilterSchema.safeParse({
        field: "x",
        operator: "not_equals",
        value: false,
      }).success
    ).toBe(true);
  });

  it("rejects unknown operators, including the table dialect's `between`", () => {
    for (const operator of ["between", "bogus", "$eq", "EQUALS"]) {
      expect(
        ViewFilterSchema.safeParse({ field: "x", operator, value: "a" })
          .success,
        operator
      ).toBe(false);
    }
  });

  it("rejects a value of the wrong shape for its operator", () => {
    const bad = [
      { field: "x", operator: "in", value: "open" },
      { field: "x", operator: "not_in", value: [{ a: 1 }] },
      { field: "x", operator: "equals" },
      { field: "x", operator: "equals", value: null },
      { field: "x", operator: "contains", value: ["a"] },
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
        field: "x",
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
    const keep = { field: "x", operator: "between", value: [1, 2] };
    expect(normalizeViewFilter(keep)).toBe(keep);
    expect(normalizeViewFilter(null)).toBe(null);
    expect(
      normalizeViewFilter({ field: "x", operator: "gte", value: 1 })
    ).toEqual({ field: "x", operator: "greater_than_or_equal", value: 1 });
  });
});
