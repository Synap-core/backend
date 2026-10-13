import { describe, expect, it } from "vitest";
import { loadFailure } from "./load-failure";

describe("loadFailure", () => {
  it("speaks in the registry noun, lowercased", () => {
    expect(loadFailure({ data: { code: "NOT_FOUND" } }, "Rule")?.title).toBe(
      "This rule couldn’t be found"
    );
    expect(loadFailure({ data: { code: "FORBIDDEN" } }, "Session")?.chip).toBe(
      "No access"
    );
    expect(loadFailure({ data: { code: "BOOM" } }, "View")?.chip).toBe(
      "Couldn’t load"
    );
  });

  it("is null without an error", () => {
    expect(loadFailure(null, "Entity")).toBeNull();
  });
});
