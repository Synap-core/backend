/**
 * D9: the row names its top fuzzy duplicate so the chip can say "Updates
 * <title>". A candidate with no title cannot be named, so it is no candidate —
 * the next-best titled one speaks, or none does.
 */
import { describe, it, expect } from "vitest";
import { topDedupCandidates } from "../capture-result-part.js";

describe("topDedupCandidates", () => {
  it("skips a titleless candidate even when it scores best", () => {
    const top = topDedupCandidates({
      t1: [
        { entityId: "e-blank", title: "   ", score: 0.95 },
        { entityId: "e-named", title: " Marie Curie ", score: 0.8 },
      ],
      t2: [{ entityId: "e-none", score: 0.9 }],
    });
    expect(top.get("t1")).toEqual({
      entityId: "e-named",
      title: "Marie Curie",
      score: 0.8,
    });
    expect(top.has("t2")).toBe(false);
  });
});
