import { describe, expect, it } from "vitest";
import { normalizeSessionTitle, resolveSessionTitle } from "./title";

/**
 * Agents sometimes XML-escape tool arguments. The session title is decoded in
 * `normalizeSessionTitle` — the ONE canonicalizer every title-writing door
 * calls — so `A &amp; B` is stored and shown as `A & B`.
 */
describe("normalizeSessionTitle decodes HTML entities", () => {
  it("decodes an escaped ampersand", () => {
    expect(normalizeSessionTitle("A &amp; B")).toBe("A & B");
  });

  it("decodes before collapsing whitespace, and still nulls a blank", () => {
    expect(normalizeSessionTitle("  Spec&nbsp;&amp;\n build ")).toBe(
      "Spec & build"
    );
    expect(normalizeSessionTitle("&nbsp;")).toBeNull();
  });

  it("the display resolver shows the decoded title", () => {
    expect(resolveSessionTitle({ title: "R&amp;D", goal: "x" })).toBe("R&D");
  });
});
