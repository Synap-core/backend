import { describe, expect, it } from "vitest";
import { buildDegradedCaptureFallback } from "./capture.js";

describe("capture fallback contract", () => {
  it("uses item for degraded capture material", () => {
    const result = buildDegradedCaptureFallback(
      "A raw thought that could not be structured",
      "is_invalid_response"
    );

    expect(result.proposals).toEqual([
      expect.objectContaining({
        profileSlug: "item",
        properties: {
          content: "A raw thought that could not be structured",
        },
      }),
    ]);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("is_invalid_response");
  });
});
