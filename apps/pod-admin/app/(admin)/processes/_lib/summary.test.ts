import { describe, expect, it } from "vitest";
import { templateSummary } from "./summary";

describe("templateSummary", () => {
  it("prefers the description's first sentence", () => {
    expect(
      templateSummary("Runs a dev task. Then reports.", "Build {feature}")
    ).toBe("Runs a dev task.");
  });
  it("reads goal references as names", () => {
    expect(
      templateSummary(null, "Research @{arg:company} for {owner}.\nMore.")
    ).toBe("Research ‹company› for ‹owner›.");
  });
  it("is null with nothing to say and bounded when long", () => {
    expect(templateSummary("  ", null)).toBeNull();
    expect(templateSummary("x".repeat(300), null)!.length).toBe(201);
  });
});
