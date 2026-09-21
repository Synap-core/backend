import { describe, it, expect } from "vitest";
import { __readParamsArgForTest as readParamsArg } from "./session.js";

/**
 * Params off the MCP wire.
 *
 * Observed live 2026-09-21: the identical `synap_start_session` call stored its
 * params over raw HTTP and LOST them through an MCP client that JSON-encoded
 * the object as a string. The handler accepted only a real object, so the
 * string was dropped — and because an unanswered required param becomes an
 * owed slot, the session then reported *"Nobody supplied it"* about a value the
 * caller had supplied. A confident falsehood about the caller's own input is
 * worse than a refusal.
 */
describe("readParamsArg — object, string-encoded, or loudly refused", () => {
  it("a real object passes through", () => {
    expect(readParamsArg({ clientName: "Acme" })).toEqual({
      clientName: "Acme",
    });
  });

  it("THE LIVE CASE: a JSON-encoded string is parsed, not dropped", () => {
    expect(readParamsArg('{"clientName":"Acme"}')).toEqual({
      clientName: "Acme",
    });
  });

  it("absent stays absent — supplying nothing is a real answer", () => {
    expect(readParamsArg(undefined)).toBeUndefined();
    expect(readParamsArg(null)).toBeUndefined();
    expect(readParamsArg("")).toBeUndefined();
    expect(readParamsArg("   ")).toBeUndefined();
  });

  it("a string that is not JSON REFUSES — never reads as 'nobody supplied'", () => {
    // The discriminating pair against the old behaviour: this input and the
    // `undefined` above must NOT produce the same result.
    expect(() => readParamsArg("clientName=Acme")).toThrow(/not JSON/i);
  });

  it("JSON that is not an object refuses, and says what it got", () => {
    expect(() => readParamsArg("[1,2]")).toThrow(/array/i);
    expect(() => readParamsArg("42")).toThrow(/number/i);
    expect(() => readParamsArg('"hello"')).toThrow(/string/i);
  });

  it("an empty object is CARRIED, not treated as absent", () => {
    // A caller who supplied nothing for an all-optional playbook is distinct
    // from a caller who supplied nothing at all.
    expect(readParamsArg({})).toEqual({});
  });
});
