/**
 * `diffIgnoredDeclarations` — what the caller declared vs what is stored, for a
 * slug that already exists. It is the payload that makes `status: "unchanged"`
 * actionable rather than a shrug.
 *
 * The discriminating rows are the ones where a plausible WRONG rule disagrees:
 *   - an UNDECLARED field (`undefined`) must not be reported — a rule that
 *     compared `undefined` against the stored value would report every field
 *     the caller never mentioned;
 *   - key ORDER must not be a difference — a `JSON.stringify` compare would
 *     report `{a,b}` vs `{b,a}` as ignored;
 *   - a MATCHING declaration must produce an empty list — a rule that reported
 *     "existing ⇒ everything ignored" would pass every other row here.
 */

import { describe, expect, it } from "vitest";

import { diffIgnoredDeclarations } from "./create-and-link-property-def.js";

const STORED = {
  id: "def-1",
  slug: "ek-type",
  valueType: "string",
  constraints: {},
  uiHints: { label: "ek_type" },
};

describe("diffIgnoredDeclarations", () => {
  it("names a declared constraint the stored def does not carry", () => {
    expect(
      diffIgnoredDeclarations(
        { valueType: "string", constraints: { enum: ["a", "b"] } },
        STORED
      )
    ).toEqual([
      { field: "constraints", declared: { enum: ["a", "b"] }, stored: {} },
    ]);
  });

  it("names a declared valueType that differs", () => {
    expect(diffIgnoredDeclarations({ valueType: "number" }, STORED)).toEqual([
      { field: "valueType", declared: "number", stored: "string" },
    ]);
  });

  it("ignores fields the caller did not declare", () => {
    expect(diffIgnoredDeclarations({ valueType: "string" }, STORED)).toEqual(
      []
    );
  });

  it("is order-insensitive across object keys", () => {
    expect(
      diffIgnoredDeclarations(
        { valueType: "string", uiHints: { b: 2, a: 1 } },
        { ...STORED, uiHints: { a: 1, b: 2 } }
      )
    ).toEqual([]);
  });

  it("reports an empty list when every declared field matches", () => {
    expect(
      diffIgnoredDeclarations(
        { valueType: "string", constraints: {}, uiHints: { label: "ek_type" } },
        STORED
      )
    ).toEqual([]);
  });
});
