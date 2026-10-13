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

  it("names a degraded capture from its first line, never a 80-character cut", () => {
    const text =
      "Call the landlord about the broken heating before the weekend\nHe said Thursday works.";
    const [proposal] = buildDegradedCaptureFallback(
      text,
      "is_invalid_response"
    ).proposals;
    expect(proposal!.title).toBe(
      "Call the landlord about the broken heating before the weekend"
    );
    expect(proposal!.title).not.toMatch(/…$/);
    // The full text survives where the title could not hold it.
    expect(proposal!.description).toBe(text);
    // A text that IS its own title carries no description.
    expect(
      buildDegradedCaptureFallback("Grants deny by default", "is_empty_result")
        .proposals[0]!.description
    ).toBeUndefined();
  });
});
