import { describe, expect, it } from "vitest";

import { CaptureGraphRawSourceSchema } from "./misc.js";

describe("CaptureGraphRawSourceSchema", () => {
  it("accepts bounded proposal provenance without treating it as a source artifact", () => {
    expect(
      CaptureGraphRawSourceSchema.parse({
        rawText: "Met Sarah at Acme; send the deck Friday.",
        sourceUrl: "https://example.com/meeting/42",
        label: "Meeting note",
        mimeType: "text/plain",
        hash: "sha256:abc123",
        idempotencyKey: "raycast-capture-42",
      })
    ).toMatchObject({
      label: "Meeting note",
      rawText: "Met Sarah at Acme; send the deck Friday.",
    });
  });

  it("rejects an empty descriptor and oversized raw text", () => {
    expect(CaptureGraphRawSourceSchema.safeParse({}).success).toBe(false);
    expect(
      CaptureGraphRawSourceSchema.safeParse({ rawText: "x".repeat(100_001) })
        .success
    ).toBe(false);
  });
});
