import { describe, expect, it } from "vitest";
import { processSummary } from "./summary";

describe("processSummary", () => {
  it("keeps the description's first sentence", () => {
    expect(processSummary("Runs a dev task. Then reports.")).toBe(
      "Runs a dev task."
    );
  });
  it("is null with nothing to say and bounded when long", () => {
    expect(processSummary("  ")).toBeNull();
    expect(processSummary(null)).toBeNull();
    expect(processSummary("x".repeat(300))!.length).toBe(201);
  });
});
