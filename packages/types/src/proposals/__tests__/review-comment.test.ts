import { describe, expect, it } from "vitest";
import {
  buildApprovalComment,
  readProposalReviewComments,
} from "../review-comment.js";

describe("proposal review comment", () => {
  it("builds an approval entry, trimmed; nothing to say ⇒ null", () => {
    const at = new Date("2026-10-11T10:00:00.000Z");
    expect(buildApprovalComment("  ship it  ", "u1", at)).toEqual({
      kind: "approval",
      text: "ship it",
      by: "u1",
      at: "2026-10-11T10:00:00.000Z",
    });
    expect(buildApprovalComment("   ", "u1", at)).toBeNull();
    expect(buildApprovalComment(undefined, "u1", at)).toBeNull();
  });

  it("reads the column back, skipping malformed entries", () => {
    const good = { kind: "approval", text: "ok", by: "u1", at: "t" };
    expect(
      readProposalReviewComments([
        good,
        { kind: "nope", text: "x", by: "u", at: "t" },
        { kind: "approval", text: "  ", by: "u", at: "t" },
        null,
        "x",
      ])
    ).toEqual([good]);
    expect(readProposalReviewComments(null)).toEqual([]);
  });
});
