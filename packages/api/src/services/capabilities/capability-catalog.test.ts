import { describe, it, expect } from "vitest";
import { extractParamsSchema } from "./capability-catalog.js";

/**
 * `extractParamsSchema` — the projection every run form / inspector reads.
 *
 * The seeded corpus declares ZERO JSON-schema `parameters`; 54 of 75 skills use
 * the FLAT convention (`{ "prompt": "string?" }`), whose value carries BOTH the
 * type and the optionality. That value used to be discarded, so 151 params
 * across 54 verbs rendered as identical required-looking text boxes. These tests
 * pin the eight-token vocabulary AND the degradation contract: an unparseable
 * value must still yield a NAMED param, never a throw and never a drop.
 */
describe("extractParamsSchema — flat convention", () => {
  // The closed vocabulary actually present in the seeds, both polarities.
  const cases: [string, string, boolean][] = [
    ["string", "string", true],
    ["string?", "string", false],
    ["number", "number", true],
    ["number?", "number", false],
    ["boolean?", "boolean", false],
    ["array", "array", true],
    ["array?", "array", false],
    ["object?", "object", false],
  ];

  for (const [token, type, required] of cases) {
    it(`parses "${token}" → type ${type}, required ${required}`, () => {
      expect(extractParamsSchema({ p: token })).toEqual([
        { name: "p", type, required },
      ]);
    });
  }

  it("parses a whole multi-param skill, preserving declaration order", () => {
    expect(
      extractParamsSchema({
        entityId: "string",
        limit: "number?",
        includeDrafts: "boolean?",
      })
    ).toEqual([
      { name: "entityId", type: "string", required: true },
      { name: "limit", type: "number", required: false },
      { name: "includeDrafts", type: "boolean", required: false },
    ]);
  });

  it("accepts `integer` — the next primitive an author would reach for", () => {
    expect(extractParamsSchema({ n: "integer?" })).toEqual([
      { name: "n", type: "integer", required: false },
    ]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(extractParamsSchema({ p: "  string?  " })).toEqual([
      { name: "p", type: "string", required: false },
    ]);
  });
});

describe("extractParamsSchema — degradation (never throw, never drop)", () => {
  it("keeps an UNKNOWN token as a named-but-untyped param", () => {
    // A freehand value an author might write instead of a type token.
    expect(extractParamsSchema({ to: "the recipient's email" })).toEqual([
      { name: "to" },
    ]);
  });

  it("keeps a param whose value is not a string at all", () => {
    expect(
      extractParamsSchema({ a: 42, b: null, c: { nested: true }, d: ["x"] })
    ).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }]);
  });

  it("does not treat a bare '?' as a typed param", () => {
    expect(extractParamsSchema({ p: "?" })).toEqual([{ name: "p" }]);
  });

  it("degrades PER PARAM — one bad value never poisons its siblings", () => {
    expect(
      extractParamsSchema({ good: "string", bad: "whatever", also: "number?" })
    ).toEqual([
      { name: "good", type: "string", required: true },
      { name: "bad" },
      { name: "also", type: "number", required: false },
    ]);
  });

  it("returns [] for a non-object blob and never throws", () => {
    expect(extractParamsSchema(null)).toEqual([]);
    expect(extractParamsSchema(undefined)).toEqual([]);
    expect(extractParamsSchema("string")).toEqual([]);
    expect(extractParamsSchema(["a"])).toEqual([]);
    expect(extractParamsSchema({})).toEqual([]);
  });
});

describe("extractParamsSchema — JSON-schema shape is unchanged", () => {
  it("still reads properties / required / description", () => {
    expect(
      extractParamsSchema({
        properties: {
          q: { type: "string", description: "Search text" },
          n: { type: "number" },
        },
        required: ["q"],
      })
    ).toEqual([
      { name: "q", type: "string", required: true, description: "Search text" },
      { name: "n", type: "number", required: false },
    ]);
  });

  it("does NOT apply flat parsing inside a JSON-schema blob", () => {
    // `properties` wins; the `?` convention is a flat-shape-only encoding.
    expect(
      extractParamsSchema({ properties: { q: { type: "string?" } } })
    ).toEqual([{ name: "q", type: "string?", required: false }]);
  });
});
