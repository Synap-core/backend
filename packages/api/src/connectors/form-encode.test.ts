import { describe, expect, it } from "vitest";
import { encodeFormBody } from "./form-encode.js";

/**
 * The bracket-nesting form encoding Stripe v1 reads (the same its SDKs send).
 * Each row is decoded back with URLSearchParams, the way a form decoder reads
 * it, so the assertion is what the provider receives, not the escaping.
 */
const decoded = (body: Record<string, unknown>) => [
  ...new URLSearchParams(encodeFormBody(body)),
];

describe("encodeFormBody", () => {
  it("flat scalars: strings, numbers and booleans as their string form", () => {
    expect(decoded({ amount: 1999, currency: "eur", active: false })).toEqual([
      ["amount", "1999"],
      ["currency", "eur"],
      ["active", "false"],
    ]);
  });

  it("nested objects use brackets, at any depth", () => {
    expect(
      decoded({ head_office: { address: { country: "FR", city: "Paris" } } })
    ).toEqual([
      ["head_office[address][country]", "FR"],
      ["head_office[address][city]", "Paris"],
    ]);
  });

  it("arrays are indexed, objects inside arrays nest under the index", () => {
    expect(
      decoded({
        line_items: [{ price: "price_1", quantity: 2 }],
        expand: ["data.customer", "data.invoice"],
      })
    ).toEqual([
      ["line_items[0][price]", "price_1"],
      ["line_items[0][quantity]", "2"],
      ["expand[0]", "data.customer"],
      ["expand[1]", "data.invoice"],
    ]);
  });

  it("null, an empty object and an empty array send an empty value (Stripe unsets); undefined is left out", () => {
    expect(
      decoded({ description: null, metadata: {}, tags: [], skip: undefined })
    ).toEqual([
      ["description", ""],
      ["metadata", ""],
      ["tags", ""],
    ]);
  });

  it("reserved characters in keys and values survive the round trip", () => {
    expect(
      decoded({ metadata: { "a&b=c": "x y&z=1+2%" }, email: "a+b@c.fr" })
    ).toEqual([
      ["metadata[a&b=c]", "x y&z=1+2%"],
      ["email", "a+b@c.fr"],
    ]);
  });

  it("an empty object encodes to nothing", () => {
    expect(encodeFormBody({})).toBe("");
  });
});
