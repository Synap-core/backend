import { describe, it, expect } from "vitest";
import { addEnumOptionRefusal, withAddedEnumOption } from "./property-enum.js";

/**
 * Option C of decision fa6c8833: a value may join a field's closed set only
 * when it is a NEW idea — never on the kind's lifecycle, never one typo away
 * from an allowed value. One rule, read by the repair card and by
 * `synap_define_kind`.
 */
const categories = { constraints: { enum: ["preferences", "habits"] } };

describe("addEnumOptionRefusal", () => {
  it("allows a value no allowed one is close to", () => {
    expect(addEnumOptionRefusal(categories, "rituals")).toBeNull();
  });

  it("refuses a near twin and names the allowed value", () => {
    expect(addEnumOptionRefusal(categories, "preference")).toEqual({
      refusal: "close_match",
      closest: "preferences",
    });
  });

  it("refuses on the kind's lifecycle, even for a new idea", () => {
    expect(
      addEnumOptionRefusal({ ...categories, isLifecycle: true }, "rituals")
    ).toEqual({ refusal: "lifecycle" });
  });

  it("refuses a value already allowed, and a field with no closed set", () => {
    expect(addEnumOptionRefusal(categories, "habits")).toEqual({
      refusal: "already_allowed",
    });
    expect(addEnumOptionRefusal({ constraints: {} }, "x")).toEqual({
      refusal: "not_a_closed_set",
    });
  });
});

describe("withAddedEnumOption", () => {
  it("grows the bare key list and keeps the other constraints", () => {
    expect(withAddedEnumOption({ enum: ["a"], maxLength: 9 }, "b")).toEqual({
      enum: ["a", "b"],
      maxLength: 9,
    });
  });

  it("grows the option objects and derives the key list from them", () => {
    expect(
      withAddedEnumOption(
        { enumOptions: [{ key: "a", label: "A" }], enum: ["a"] },
        "b"
      )
    ).toEqual({
      enumOptions: [{ key: "a", label: "A" }, { key: "b" }],
      enum: ["a", "b"],
    });
  });
});
