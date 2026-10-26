import { describe, expect, it } from "vitest";
import { leanProposal } from "./proposal-lean.js";

const BIG = { ops: "x".repeat(5000) };
const row = {
  id: "p1",
  status: "approval_failed",
  data: { ...BIG, failure: { errorClass: "missing_field" } },
  request: { data: BIG, summary: "Create X", targetName: "X" },
  review: { changes: [{ field: "title" }], title: "Create X" },
  revisionHistory: [
    {
      at: "2026-10-01",
      by: "u1",
      before: { title: "a".repeat(2000) },
      patch: { title: "b", body: "c" },
    },
  ],
  authorName: "Agent",
};

describe("leanProposal", () => {
  const lean = leanProposal(row);

  it("keeps one copy of the payload, the review, status and provenance", () => {
    expect(lean.data).toEqual(row.data);
    expect((lean.data as { failure: unknown }).failure).toBeDefined();
    expect(lean.review).toEqual(row.review);
    expect(lean.status).toBe("approval_failed");
    expect(lean.authorName).toBe("Agent");
    expect(lean.request).toEqual({ summary: "Create X", targetName: "X" });
  });

  it("drops request.data and the revision bodies", () => {
    expect(lean.request).not.toHaveProperty("data");
    expect(lean.revisionHistory).toEqual([
      { at: "2026-10-01", by: "u1", patchedFields: ["title", "body"] },
    ]);
    expect(JSON.stringify(lean).length).toBeLessThan(
      JSON.stringify(row).length / 1.8
    );
  });
});
