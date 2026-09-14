import { describe, expect, it } from "vitest";
import {
  FALLBACK_CAPTURE_KIND,
  buildDegradedCaptureFallback,
} from "./capture.js";

/**
 * The degraded capture fallback, pinned at the SEAM: the one builder both
 * degraded outcomes use must return BOTH halves — it is degraded, and it files
 * as the fallback kind. Pinning only the constant would stay green while the
 * builder stopped using it (or stopped saying it is degraded).
 */
describe("capture fallback contract", () => {
  it("the fallback kind is note (item is retired as the catch-all)", () => {
    expect(FALLBACK_CAPTURE_KIND).toBe("note");
  });

  it("degraded capture material is degraded AND files as the fallback kind", () => {
    const result = buildDegradedCaptureFallback(
      "A raw thought that could not be structured",
      "is_invalid_response"
    );

    expect(result.degraded).toBe(true);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.profileSlug).toBe(FALLBACK_CAPTURE_KIND);
    expect(result.proposals).toEqual([
      expect.objectContaining({
        profileSlug: "note",
        properties: {
          content: "A raw thought that could not be structured",
        },
      }),
    ]);
    expect(result.degradedReason).toBe("is_invalid_response");
  });
});
