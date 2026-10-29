/**
 * `lastInteractionAt` (the projection of "when we last spoke", 0359) is
 * bookkeeping: bumped by every synced meeting, it must never reach the embed
 * text, or each bump would move the person's vector. The other short string
 * properties still do — the exclusion is one key, not the date shape.
 */
import { describe, it, expect } from "vitest";
import { buildEntityEmbeddingText } from "./entity-embedding-text.js";

describe("buildEntityEmbeddingText", () => {
  it("leaves lastInteractionAt out and keeps the rest", () => {
    const text = buildEntityEmbeddingText({
      type: "person",
      title: "Ada Lovelace",
      properties: {
        lastInteractionAt: "2026-10-20T09:00:00.000Z",
        role: "VP Product",
        birthday: "1815-12-10",
      },
    });
    expect(text).not.toContain("lastInteractionAt");
    expect(text).not.toContain("2026-10-20");
    expect(text).toContain("role: VP Product");
    expect(text).toContain("birthday: 1815-12-10");
  });
});
